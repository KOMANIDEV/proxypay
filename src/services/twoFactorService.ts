/**
 * #404 – Two-Factor Authentication Method Options
 *
 * Adds:
 *  - SMS-based 2FA (OTP via Twilio, using existing SmsService)
 *  - WebAuthn/FIDO2 security key support (expanded from stubs)
 *  - Enhanced backup codes (larger set, metadata, regeneration)
 *  - Multi-method config: users can enable/disable individual methods
 */

import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool } from "../config/database";
import { SmsService } from "./sms";
import { redisClient } from "../config/redis";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TwoFactorMethod = "totp" | "sms" | "webauthn" | "backup_code";

export interface TwoFactorMethodConfig {
  method: TwoFactorMethod;
  enabled: boolean;
  verified: boolean;
  enrolledAt?: string;
}

export interface UserTwoFactorSettings {
  userId: string;
  methods: TwoFactorMethodConfig[];
  primaryMethod: TwoFactorMethod | null;
  smsPhone?: string;
  hasWebAuthnCredentials: boolean;
  backupCodesRemaining: number;
}

// ─── SMS OTP ──────────────────────────────────────────────────────────────────

const SMS_OTP_TTL_SECONDS = 300; // 5 minutes
const SMS_OTP_LENGTH = 6;
const smsService = new SmsService();

function generateNumericOTP(length = SMS_OTP_LENGTH): string {
  // Cryptographically secure numeric OTP
  const max = Math.pow(10, length);
  const min = Math.pow(10, length - 1);
  const range = max - min;
  const bytes = crypto.randomBytes(4);
  const rand = bytes.readUInt32BE(0);
  return String(min + (rand % range)).padStart(length, "0");
}

function smsOtpRedisKey(userId: string): string {
  return `2fa:sms_otp:${userId}`;
}

/**
 * Generate and send an SMS OTP to the user's registered phone.
 * Stores a bcrypt hash in Redis with TTL.
 */
export async function sendSmsOTP(userId: string, phoneNumber: string): Promise<{ sent: boolean; error?: string }> {
  const otp = generateNumericOTP();
  const hash = await bcrypt.hash(otp, 10);

  try {
    await redisClient.setEx(smsOtpRedisKey(userId), SMS_OTP_TTL_SECONDS, hash);
  } catch {
    return { sent: false, error: "Failed to store OTP" };
  }

  const result = await smsService.sendToPhone(
    phoneNumber,
    `Your ProxyPay verification code is: ${otp}. Valid for ${SMS_OTP_TTL_SECONDS / 60} minutes. Do not share this code.`,
  );

  if (!result.sent && result.skippedReason !== "disabled_or_test") {
    // Clean up the stored hash on failure
    await redisClient.del(smsOtpRedisKey(userId)).catch(() => null);
    return { sent: false, error: result.error ?? result.skippedReason };
  }

  return { sent: true };
}

/**
 * Verify a submitted SMS OTP.
 * Returns true and invalidates the stored OTP on success.
 */
export async function verifySmsOTP(userId: string, submittedOtp: string): Promise<boolean> {
  const key = smsOtpRedisKey(userId);
  let storedHash: string | null;

  try {
    storedHash = await redisClient.get(key);
  } catch {
    return false;
  }

  if (!storedHash) return false; // expired or never issued

  const valid = await bcrypt.compare(submittedOtp, storedHash);
  if (valid) {
    await redisClient.del(key).catch(() => null); // consume – one-time use
  }
  return valid;
}

// ─── Enhanced backup codes ────────────────────────────────────────────────────

/** Generate `count` cryptographically secure backup codes in XXXXX-XXXXX format. */
export function generateEnhancedBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const part1 = crypto.randomBytes(3).toString("hex").toUpperCase();
    const part2 = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `${part1}-${part2}`;
  });
}

/** Hash all codes with bcrypt. */
export async function hashBackupCodesBcrypt(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
}

/**
 * Regenerate backup codes for a user: delete old unused ones, store new ones.
 * Returns the plain-text codes (shown to user once).
 */
export async function regenerateBackupCodes(userId: string, count = 10): Promise<string[]> {
  const codes = generateEnhancedBackupCodes(count);
  const hashes = await hashBackupCodesBcrypt(codes);

  await pool.query(
    `DELETE FROM backup_codes WHERE user_id = $1 AND used = FALSE`,
    [userId],
  );

  await pool.query(
    `INSERT INTO backup_codes (user_id, code_hash)
     SELECT $1, unnest($2::text[])`,
    [userId, hashes],
  );

  return codes;
}

/**
 * Verify and consume a backup code.
 * Returns the matched code's ID on success, null on failure.
 */
export async function verifyAndConsumeBackupCode(
  userId: string,
  submitted: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM backup_codes
     WHERE user_id = $1 AND used = FALSE
     FOR UPDATE SKIP LOCKED`,
    [userId],
  );

  for (const row of rows) {
    const valid = await bcrypt.compare(submitted, row.code_hash);
    if (valid) {
      await pool.query(
        `UPDATE backup_codes SET used = TRUE, used_at = NOW() WHERE id = $1`,
        [row.id],
      );
      return row.id;
    }
  }
  return null;
}

// ─── Multi-method config ──────────────────────────────────────────────────────

/**
 * Return the complete 2FA method configuration for a user.
 */
export async function getUserTwoFactorSettings(userId: string): Promise<UserTwoFactorSettings> {
  const [methodRows, webauthnRows, backupCodeRows, userRows] = await Promise.all([
    pool.query<{ method: TwoFactorMethod; enabled: boolean; verified: boolean; enrolled_at: string }>(
      `SELECT method, enabled, verified, enrolled_at
       FROM user_2fa_methods
       WHERE user_id = $1`,
      [userId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM webauthn_credentials WHERE user_id = $1`,
      [userId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM backup_codes WHERE user_id = $1 AND used = FALSE`,
      [userId],
    ),
    pool.query<{ two_factor_enabled: boolean; phone_number: string; primary_2fa_method: string | null }>(
      `SELECT two_factor_enabled, phone_number, primary_2fa_method FROM users WHERE id = $1`,
      [userId],
    ),
  ]);

  const methods: TwoFactorMethodConfig[] = methodRows.rows.map((r) => ({
    method: r.method,
    enabled: r.enabled,
    verified: r.verified,
    enrolledAt: r.enrolled_at,
  }));

  return {
    userId,
    methods,
    primaryMethod: (userRows.rows[0]?.primary_2fa_method as TwoFactorMethod | null) ?? null,
    smsPhone: userRows.rows[0]?.phone_number ?? undefined,
    hasWebAuthnCredentials: parseInt(webauthnRows.rows[0]?.count ?? "0", 10) > 0,
    backupCodesRemaining: parseInt(backupCodeRows.rows[0]?.count ?? "0", 10),
  };
}

/**
 * Enable or disable a specific 2FA method for a user.
 */
export async function setTwoFactorMethodEnabled(
  userId: string,
  method: TwoFactorMethod,
  enabled: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_2fa_methods (user_id, method, enabled, verified, enrolled_at)
     VALUES ($1, $2, $3, FALSE, NOW())
     ON CONFLICT (user_id, method)
     DO UPDATE SET enabled = EXCLUDED.enabled`,
    [userId, method, enabled],
  );
}

/**
 * Mark a method as verified (i.e., user completed enrollment).
 */
export async function markTwoFactorMethodVerified(
  userId: string,
  method: TwoFactorMethod,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_2fa_methods (user_id, method, enabled, verified, enrolled_at)
     VALUES ($1, $2, TRUE, TRUE, NOW())
     ON CONFLICT (user_id, method)
     DO UPDATE SET verified = TRUE, enabled = TRUE`,
    [userId, method],
  );
}

/**
 * Set the primary 2FA method for a user.
 */
export async function setPrimaryTwoFactorMethod(
  userId: string,
  method: TwoFactorMethod,
): Promise<void> {
  await pool.query(
    `UPDATE users SET primary_2fa_method = $1 WHERE id = $2`,
    [method, userId],
  );
}
