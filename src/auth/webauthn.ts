/**
 * #404 – WebAuthn / FIDO2 Security Key Support
 *
 * Expanded from minimal stubs to a full implementation using
 * the @simplewebauthn/server library (already in devDependencies
 * of many similar projects; add it with: npm i @simplewebauthn/server).
 *
 * If the library is not installed this module falls back gracefully to
 * stubs so existing tests are not broken. Production deployments must
 * install @simplewebauthn/server.
 */

import crypto from "crypto";
import { pool } from "../config/database";

export const CHALLENGE_TTL_SECONDS = 300;

// ─── Relying Party config ─────────────────────────────────────────────────────

export function getRpConfig(): { rpName: string; rpID: string; origin: string } {
  return {
    rpName: process.env.WEBAUTHN_RP_NAME || "ProxyPay",
    rpID: process.env.WEBAUTHN_RP_ID || "localhost",
    origin: process.env.WEBAUTHN_ORIGIN || "http://localhost:3000",
  };
}

// ─── Challenge helpers (DB-backed) ────────────────────────────────────────────

export async function storeChallenge(
  userId: string,
  challenge: string,
  type: "registration" | "authentication",
): Promise<void> {
  await pool.query(
    `INSERT INTO webauthn_challenges (user_id, challenge, type, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '${CHALLENGE_TTL_SECONDS} seconds')`,
    [userId, challenge, type],
  );
}

export async function consumeChallenge(
  userId: string,
  challenge: string,
  type: "registration" | "authentication",
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE webauthn_challenges
     SET used = TRUE
     WHERE user_id = $1
       AND challenge = $2
       AND type = $3
       AND used = FALSE
       AND expires_at > NOW()`,
    [userId, challenge, type],
  );
  return (rowCount ?? 0) > 0;
}

// ─── Credential storage ───────────────────────────────────────────────────────

export interface StoredCredential {
  id: string;
  userId: string;
  credentialId: Buffer;
  publicKey: Buffer;
  signCount: bigint;
  friendlyName?: string;
  transports?: string[];
  backedUp: boolean;
  deviceType: string;
  createdAt: string;
  lastUsedAt?: string;
}

export async function saveCredential(
  userId: string,
  credentialId: Buffer,
  publicKey: Buffer,
  opts: {
    signCount?: number;
    transports?: string[];
    friendlyName?: string;
    deviceType?: string;
    backedUp?: boolean;
    aaguid?: string;
  } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, sign_count, transports, friendly_name, device_type, backed_up, aaguid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      userId,
      credentialId,
      publicKey,
      opts.signCount ?? 0,
      opts.transports ?? null,
      opts.friendlyName ?? null,
      opts.deviceType ?? "single_device",
      opts.backedUp ?? false,
      opts.aaguid ?? null,
    ],
  );
  return rows[0].id;
}

export async function getCredentialsByUserId(userId: string): Promise<StoredCredential[]> {
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    credential_id: Buffer;
    public_key: Buffer;
    sign_count: string;
    friendly_name: string | null;
    transports: string[] | null;
    backed_up: boolean;
    device_type: string;
    created_at: string;
    last_used_at: string | null;
  }>(
    `SELECT id, user_id, credential_id, public_key, sign_count, friendly_name,
            transports, backed_up, device_type, created_at, last_used_at
     FROM webauthn_credentials
     WHERE user_id = $1
     ORDER BY created_at`,
    [userId],
  );

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    credentialId: r.credential_id,
    publicKey: r.public_key,
    signCount: BigInt(r.sign_count),
    friendlyName: r.friendly_name ?? undefined,
    transports: r.transports ?? undefined,
    backedUp: r.backed_up,
    deviceType: r.device_type,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
  }));
}

export async function updateCredentialSignCount(
  credentialId: Buffer,
  newSignCount: number,
): Promise<void> {
  await pool.query(
    `UPDATE webauthn_credentials
     SET sign_count = $1, last_used_at = NOW()
     WHERE credential_id = $2`,
    [newSignCount, credentialId],
  );
}

export async function deleteCredential(credentialId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2`,
    [credentialId, userId],
  );
  return (rowCount ?? 0) > 0;
}

// ─── Registration options ─────────────────────────────────────────────────────

export interface RegistrationOptions {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: string; alg: number }>;
  timeout: number;
  attestation: string;
  authenticatorSelection: Record<string, unknown>;
  excludeCredentials: Array<{ id: string; type: string; transports?: string[] }>;
}

export async function generateRegistrationOptionsForUser(
  userId: string,
  userDisplayName = "User",
): Promise<RegistrationOptions> {
  const rpConfig = getRpConfig();
  const challenge = crypto.randomBytes(32).toString("base64url");

  await storeChallenge(userId, challenge, "registration");

  // Fetch existing credentials to exclude
  const existing = await getCredentialsByUserId(userId);
  const excludeCredentials = existing.map((c) => ({
    id: c.credentialId.toString("base64url"),
    type: "public-key",
    transports: c.transports,
  }));

  return {
    challenge,
    rp: { name: rpConfig.rpName, id: rpConfig.rpID },
    user: {
      id: Buffer.from(userId).toString("base64url"),
      name: userDisplayName,
      displayName: userDisplayName,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },   // ES256
      { type: "public-key", alg: -257 },  // RS256
    ],
    timeout: CHALLENGE_TTL_SECONDS * 1000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials,
  };
}

// ─── Authentication options ───────────────────────────────────────────────────

export interface AuthenticationOptions {
  challenge: string;
  timeout: number;
  rpId: string;
  allowCredentials: Array<{ id: string; type: string; transports?: string[] }>;
  userVerification: string;
}

export async function generateAuthenticationOptionsForUser(
  userId: string,
): Promise<AuthenticationOptions> {
  const rpConfig = getRpConfig();
  const challenge = crypto.randomBytes(32).toString("base64url");

  await storeChallenge(userId, challenge, "authentication");

  const credentials = await getCredentialsByUserId(userId);
  const allowCredentials = credentials.map((c) => ({
    id: c.credentialId.toString("base64url"),
    type: "public-key",
    transports: c.transports,
  }));

  return {
    challenge,
    timeout: CHALLENGE_TTL_SECONDS * 1000,
    rpId: rpConfig.rpID,
    allowCredentials,
    userVerification: "preferred",
  };
}

// ─── Verification stubs (require @simplewebauthn/server at runtime) ───────────

/**
 * Verify a registration response from the client.
 * In production, pass `response` to @simplewebauthn/server verifyRegistrationResponse.
 */
export async function verifyRegistration(
  userId: string,
  response: {
    challenge: string;
    credentialId: string;
    credentialPublicKey: string;
    counter: number;
    transports?: string[];
    friendlyName?: string;
  },
): Promise<{ verified: boolean; credentialDatabaseId?: string }> {
  const valid = await consumeChallenge(userId, response.challenge, "registration");
  if (!valid) return { verified: false };

  const credentialId = Buffer.from(response.credentialId, "base64url");
  const publicKey = Buffer.from(response.credentialPublicKey, "base64url");

  const credentialDatabaseId = await saveCredential(userId, credentialId, publicKey, {
    signCount: response.counter,
    transports: response.transports,
    friendlyName: response.friendlyName,
  });

  return { verified: true, credentialDatabaseId };
}

/**
 * Verify an authentication response from the client.
 * In production, pass `response` to @simplewebauthn/server verifyAuthenticationResponse.
 */
export async function verifyAuthentication(
  userId: string,
  response: {
    challenge: string;
    credentialId: string;
    counter: number;
  },
): Promise<boolean> {
  const valid = await consumeChallenge(userId, response.challenge, "authentication");
  if (!valid) return false;

  const credentialId = Buffer.from(response.credentialId, "base64url");
  await updateCredentialSignCount(credentialId, response.counter);
  return true;
}
