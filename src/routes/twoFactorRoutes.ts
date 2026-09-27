/**
 * #404 – Two-Factor Authentication Method Routes
 *
 * GET  /api/auth/2fa/methods                  – list enabled methods for user
 * POST /api/auth/2fa/methods/:method/enable   – enable a method
 * POST /api/auth/2fa/methods/:method/disable  – disable a method
 * POST /api/auth/2fa/methods/primary          – set primary method
 *
 * SMS 2FA:
 * POST /api/auth/2fa/sms/send                 – send OTP to registered phone
 * POST /api/auth/2fa/sms/verify               – verify OTP
 *
 * WebAuthn:
 * POST /api/auth/2fa/webauthn/registration-options
 * POST /api/auth/2fa/webauthn/verify-registration
 * POST /api/auth/2fa/webauthn/authentication-options
 * POST /api/auth/2fa/webauthn/verify-authentication
 * GET  /api/auth/2fa/webauthn/credentials
 * DELETE /api/auth/2fa/webauthn/credentials/:id
 *
 * Backup codes:
 * POST /api/auth/2fa/backup-codes/regenerate  – regenerate backup codes
 * GET  /api/auth/2fa/backup-codes/count       – remaining unused count
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateToken } from "../middleware/auth";
import { validateRequest } from "../middleware/validation";
import {
  sendSmsOTP,
  verifySmsOTP,
  regenerateBackupCodes,
  verifyAndConsumeBackupCode,
  getUserTwoFactorSettings,
  setTwoFactorMethodEnabled,
  markTwoFactorMethodVerified,
  setPrimaryTwoFactorMethod,
  type TwoFactorMethod,
} from "../services/twoFactorService";
import {
  generateRegistrationOptionsForUser,
  generateAuthenticationOptionsForUser,
  verifyRegistration,
  verifyAuthentication,
  getCredentialsByUserId,
  deleteCredential,
} from "../auth/webauthn";
import { pool } from "../config/database";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

const VALID_METHODS: TwoFactorMethod[] = ["totp", "sms", "webauthn", "backup_code"];

// ─── GET /methods ─────────────────────────────────────────────────────────────

router.get("/methods", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  const settings = await getUserTwoFactorSettings(userId);
  res.json({ data: settings });
});

// ─── POST /methods/:method/enable ─────────────────────────────────────────────

router.post(
  "/methods/:method/enable",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const method = req.params.method as TwoFactorMethod;
    if (!VALID_METHODS.includes(method)) {
      throw createError(ERROR_CODES.INVALID_INPUT, `Invalid method. Valid values: ${VALID_METHODS.join(", ")}`);
    }

    await setTwoFactorMethodEnabled(userId, method, true);
    res.json({ success: true, method, enabled: true });
  },
);

// ─── POST /methods/:method/disable ────────────────────────────────────────────

router.post(
  "/methods/:method/disable",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const method = req.params.method as TwoFactorMethod;
    if (!VALID_METHODS.includes(method)) {
      throw createError(ERROR_CODES.INVALID_INPUT, `Invalid method. Valid values: ${VALID_METHODS.join(", ")}`);
    }

    await setTwoFactorMethodEnabled(userId, method, false);
    res.json({ success: true, method, enabled: false });
  },
);

// ─── POST /methods/primary ────────────────────────────────────────────────────

const SetPrimarySchema = z.object({
  method: z.enum(["totp", "sms", "webauthn", "backup_code"]),
});

router.post(
  "/methods/primary",
  authenticateToken,
  validateRequest(SetPrimarySchema),
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const { method } = req.body as z.infer<typeof SetPrimarySchema>;
    await setPrimaryTwoFactorMethod(userId, method);
    res.json({ success: true, primaryMethod: method });
  },
);

// ─── SMS 2FA ──────────────────────────────────────────────────────────────────

router.post("/sms/send", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  // Get the phone number from the users table
  const { rows } = await pool.query<{ phone_number: string }>(
    `SELECT phone_number FROM users WHERE id = $1`,
    [userId],
  );

  if (!rows.length || !rows[0].phone_number) {
    throw createError(ERROR_CODES.INVALID_INPUT, "No phone number registered for this account");
  }

  const result = await sendSmsOTP(userId, rows[0].phone_number);

  if (!result.sent && result.error) {
    console.warn("[2fa-sms] OTP send failed", { userId, error: result.error });
  }

  // Always return success to prevent phone number enumeration
  res.json({ success: true, message: "If a phone number is on file, an OTP has been sent." });
});

const VerifySmsOtpSchema = z.object({ otp: z.string().min(4).max(10) });

router.post(
  "/sms/verify",
  authenticateToken,
  validateRequest(VerifySmsOtpSchema),
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const { otp } = req.body as z.infer<typeof VerifySmsOtpSchema>;
    const valid = await verifySmsOTP(userId, otp);

    if (!valid) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Invalid or expired OTP");
    }

    await markTwoFactorMethodVerified(userId, "sms");
    res.json({ success: true, verified: true });
  },
);

// ─── WebAuthn – Registration ──────────────────────────────────────────────────

router.post(
  "/webauthn/registration-options",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const { rows } = await pool.query<{ phone_number: string }>(
      `SELECT phone_number FROM users WHERE id = $1`,
      [userId],
    );
    const displayName = rows[0]?.phone_number ?? userId;

    const options = await generateRegistrationOptionsForUser(userId, displayName);
    res.json({ data: options });
  },
);

const VerifyRegistrationSchema = z.object({
  challenge: z.string(),
  credentialId: z.string(),
  credentialPublicKey: z.string(),
  counter: z.number().int().nonnegative(),
  transports: z.array(z.string()).optional(),
  friendlyName: z.string().max(255).optional(),
});

router.post(
  "/webauthn/verify-registration",
  authenticateToken,
  validateRequest(VerifyRegistrationSchema),
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const result = await verifyRegistration(userId, req.body);

    if (!result.verified) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "WebAuthn registration verification failed");
    }

    await markTwoFactorMethodVerified(userId, "webauthn");
    res.json({ success: true, credentialId: result.credentialDatabaseId });
  },
);

// ─── WebAuthn – Authentication ────────────────────────────────────────────────

router.post(
  "/webauthn/authentication-options",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const options = await generateAuthenticationOptionsForUser(userId);
    res.json({ data: options });
  },
);

const VerifyAuthSchema = z.object({
  challenge: z.string(),
  credentialId: z.string(),
  counter: z.number().int().nonnegative(),
});

router.post(
  "/webauthn/verify-authentication",
  authenticateToken,
  validateRequest(VerifyAuthSchema),
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const valid = await verifyAuthentication(userId, req.body);
    if (!valid) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "WebAuthn authentication failed");
    }

    res.json({ success: true, authenticated: true });
  },
);

// ─── WebAuthn – Credentials management ───────────────────────────────────────

router.get(
  "/webauthn/credentials",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const credentials = await getCredentialsByUserId(userId);
    const safe = credentials.map(({ credentialId: _ci, publicKey: _pk, ...rest }) => rest);
    res.json({ data: safe });
  },
);

router.delete(
  "/webauthn/credentials/:id",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const deleted = await deleteCredential(req.params.id, userId);
    if (!deleted) {
      throw createError(ERROR_CODES.NOT_FOUND, "Credential not found");
    }
    res.json({ success: true });
  },
);

// ─── Backup codes ─────────────────────────────────────────────────────────────

router.post(
  "/backup-codes/regenerate",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const codes = await regenerateBackupCodes(userId);
    await markTwoFactorMethodVerified(userId, "backup_code");

    res.json({
      success: true,
      codes,
      warning: "Save these codes securely. They will not be shown again.",
    });
  },
);

router.get(
  "/backup-codes/count",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM backup_codes WHERE user_id = $1 AND used = FALSE`,
      [userId],
    );

    res.json({ remaining: parseInt(rows[0].count, 10) });
  },
);

const VerifyBackupCodeSchema = z.object({ code: z.string().min(6) });

router.post(
  "/backup-codes/verify",
  authenticateToken,
  validateRequest(VerifyBackupCodeSchema),
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const { code } = req.body as z.infer<typeof VerifyBackupCodeSchema>;
    const codeId = await verifyAndConsumeBackupCode(userId, code);

    if (!codeId) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Invalid or already-used backup code");
    }

    res.json({ success: true, codeId });
  },
);

export default router;
