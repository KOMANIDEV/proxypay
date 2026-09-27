
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { RefreshTokenFamilyModel } from "../models/refreshTokenFamily";
import { redisClient } from "../config/redis";

dotenv.config();

const JWT_EXPIRES_IN = "1h";
const REFRESH_TOKEN_EXPIRES_IN = "7d";
const refreshTokenFamilyModel = new RefreshTokenFamilyModel();

export interface JWTImpersonationClaim {
  active: true;
  readOnly: true;
  actorUserId: string;
  actorRole: string;
  targetUserId: string;
  reason: string;
  issuedAt: string;
}

interface GenerateTokenOptions {
  expiresIn?: string | number;
  sessionId?: string;
  binding?: string;
  /** Override which key id to use when signing (defaults to current active key). */
  keyId?: string;
}

// ---------------------------------------------------------------------------
// Key rotation support (#628)
//
// Tokens are signed with a versioned key identified by a `kid` (key id) header
// claim.  During rotation a NEW key is promoted to "active"; the previous key
// remains in the keystore for GRACE_PERIOD_MS (7 days) so that tokens issued
// before the rotation continue to verify.  After the grace period the old key
// is automatically evicted.
//
// Environment variables:
//   JWT_SECRET              — The current active signing secret (always required)
//   JWT_KEY_ID              — Identifier for JWT_SECRET (defaults to "v1")
//   JWT_PREVIOUS_SECRET     — The previous secret still accepted during rotation
//   JWT_PREVIOUS_KEY_ID     — Identifier for JWT_PREVIOUS_SECRET
//   JWT_PREVIOUS_KEY_ISSUED_AT — Unix epoch (seconds) when the old key was superseded;
//                               used to enforce the 7-day grace window
// ---------------------------------------------------------------------------

/** Grace period during which a superseded key remains valid (7 days in ms). */
export const KEY_ROTATION_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export interface JwtKeyEntry {
  keyId: string;
  secret: string;
  /** Unix epoch (ms) from which this key is the active signing key. */
  activeSince: number;
  /** Unix epoch (ms) after which this key should be rejected (for old keys). */
  expiresAt?: number;
}

/**
 * Returns the live keystore: `[activeKey, ...previousKeys]`.
 * Keys are derived from environment variables so they rotate without a redeploy
 * (assuming the environment is updated before old tokens expire).
 *
 * Exported so tests can inspect the keystore without reaching into internals.
 */
export function buildKeyStore(): JwtKeyEntry[] {
  const activeSecret = process.env.JWT_SECRET;
  if (!activeSecret) throw new Error("JWT_SECRET is not defined in environment variables");

  const activeKeyId = process.env.JWT_KEY_ID ?? "v1";
  const store: JwtKeyEntry[] = [
    { keyId: activeKeyId, secret: activeSecret, activeSince: 0 },
  ];

  const prevSecret = process.env.JWT_PREVIOUS_SECRET;
  const prevKeyId = process.env.JWT_PREVIOUS_KEY_ID;
  const prevIssuedAt = process.env.JWT_PREVIOUS_KEY_ISSUED_AT;

  if (prevSecret && prevKeyId) {
    const supersededAt = prevIssuedAt ? parseInt(prevIssuedAt, 10) * 1000 : Date.now();
    const expiresAt = supersededAt + KEY_ROTATION_GRACE_PERIOD_MS;

    // Only include the old key if we are still within the grace period.
    if (Date.now() < expiresAt) {
      store.push({ keyId: prevKeyId, secret: prevSecret, activeSince: 0, expiresAt });
    }
  }

  return store;
}

/**
 * Returns the active signing key entry (always the first entry in the store).
 */
function getActiveKey(): JwtKeyEntry {
  return buildKeyStore()[0];
}

/**
 * Looks up a key by its `kid` identifier.  Returns `undefined` if the key is
 * not in the store or its grace period has expired.
 */
export function findKeyById(keyId: string): JwtKeyEntry | undefined {
  return buildKeyStore().find((k) => k.keyId === keyId);
}

// Keep a thin backward-compat helper so internal code that still calls
// getJwtSecret() continues to work.
function getJwtSecret(): string {
  return getActiveKey().secret;
}

export interface JWTPayload {
  userId: string;
  email: string;
  role?: string;
  impersonation?: JWTImpersonationClaim;
  tokenVersion?: number;
  sessionId?: string;
  binding?: string;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  userId: string;
  familyId: string;
  tokenId: string;
  parentTokenId?: string;
  sessionId?: string;
  binding?: string;
  iat?: number;
  exp?: number;
}


/**
 * Generates a JWT token for the given user payload.
 *
 * The token header will include the `kid` of the active signing key, enabling
 * verifyToken() to select the correct key during a rotation window.
 *
 * @param payload - User data to include in the token
 * @returns Signed JWT token
 */
export function generateToken(
  payload: Omit<JWTPayload, "iat" | "exp">,
  options?: GenerateTokenOptions,
): string {
  const expiresIn = options?.expiresIn ?? JWT_EXPIRES_IN;

  // Select the signing key — allow callers to override (useful in tests)
  let signingKey: JwtKeyEntry;
  if (options?.keyId) {
    const found = findKeyById(options.keyId);
    if (!found) throw new Error(`Unknown keyId: ${options.keyId}`);
    signingKey = found;
  } else {
    signingKey = getActiveKey();
  }

  return jwt.sign({
    ...payload,
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.binding ? { binding: options.binding } : {}),
  }, signingKey.secret, {
    expiresIn: typeof expiresIn === 'string' ? expiresIn : expiresIn,
    keyid: signingKey.keyId,
  } as jwt.SignOptions);
}

export function createSessionBinding(deviceId?: string, userAgent?: string): string {
  return crypto.createHash("sha256").update(`${deviceId ?? ""}:${userAgent ?? ""}`).digest("hex");
}

const sessionKey = (sessionId: string) => `jwt:session:${sessionId}`;
const userSessionsKey = (userId: string) => `user:${userId}:jwt_sessions`;

export async function registerJwtSession(
  userId: string,
  sessionId: string,
  binding: string,
  expiresAt: number,
): Promise<void> {
  if (!redisClient.isOpen) return;
  const maxSessions = Math.max(1, Number(process.env.JWT_MAX_CONCURRENT_SESSIONS ?? 5));
  const ttl = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
  const sessionsKey = userSessionsKey(userId);

  await redisClient.set(sessionKey(sessionId), JSON.stringify({ userId, binding }), { EX: ttl });
  await redisClient.zAdd(sessionsKey, [{ score: Date.now(), value: sessionId }]);
  await redisClient.expire(sessionsKey, ttl);

  const sessions = await redisClient.zRange(sessionsKey, 0, -1);
  for (const oldSessionId of sessions.slice(0, Math.max(0, sessions.length - maxSessions))) {
    await redisClient.del(sessionKey(oldSessionId));
    await redisClient.zRem(sessionsKey, oldSessionId);
  }
}

/**
 * Generates a refresh token and tracks its family chain
 * @param userId - User's ID
 * @param familyId - Family chain ID (new for first token)
 * @param parentTokenId - Parent token ID (if rotating)
 * @returns Signed refresh token
 */
export async function generateRefreshToken(
  userId: string,
  familyId?: string,
  parentTokenId?: string,
  session?: { sessionId: string; binding: string },
): Promise<string> {
  const tokenId = uuidv4();
  const famId = familyId || uuidv4();
  const payload: RefreshTokenPayload = {
    userId,
    familyId: famId,
    tokenId,
    parentTokenId,
    ...session,
  };
  const signingKey = getActiveKey();
  const token = jwt.sign(payload, signingKey.secret, {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    keyid: signingKey.keyId,
  });
  await refreshTokenFamilyModel.create({ user_id: userId, family_id: famId, token, parent_token: parentTokenId });
  return token;
}


/**
 * Verifies a JWT token and returns the decoded payload.
 *
 * Key rotation is supported: the `kid` header is read from the token and used
 * to look up the matching secret in the keystore.  During a rotation window
 * both the new and the previous key are accepted.  Tokens signed with an
 * expired or unknown key are rejected.
 *
 * @param token - JWT token to verify
 * @returns Decoded token payload
 * @throws Error if token is invalid, expired, or signed with an unknown/expired key
 */
export function verifyToken(token: string): JWTPayload {
  // Decode without verification first to read the `kid` header.
  const unverified = jwt.decode(token, { complete: true });
  const kid = (unverified?.header as any)?.kid as string | undefined;

  // Select the correct secret for this key id.
  let secret: string;
  if (kid) {
    const entry = findKeyById(kid);
    if (!entry) {
      throw new Error(`Invalid token: unknown key id '${kid}'`);
    }
    secret = entry.secret;
  } else {
    // Tokens issued before key rotation support (no kid) fall back to the active secret.
    secret = getJwtSecret();
  }

  try {
    const decoded = jwt.verify(token, secret, { clockTolerance: 60 }) as JWTPayload;
    return decoded;
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Token has expired", { cause: error });
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid token", { cause: error });
    } else {
      throw new Error("Token verification failed", { cause: error });
    }
  }
}

/**
 * Verifies a refresh token, detects reuse, and revokes family if reused
 * @param token - Refresh token to verify
 * @returns Decoded refresh token payload
 * @throws Error if token is invalid, expired, or reused
 */
export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  // Decode without verification first to read the `kid` header.
  const unverified = jwt.decode(token, { complete: true });
  const kid = (unverified?.header as any)?.kid as string | undefined;

  let secret: string;
  if (kid) {
    const entry = findKeyById(kid);
    if (!entry) throw new Error(`Invalid refresh token: unknown key id '${kid}'`);
    secret = entry.secret;
  } else {
    secret = getJwtSecret();
  }

  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(token, secret) as RefreshTokenPayload;
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Refresh token has expired", { cause: error });
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid refresh token", { cause: error });
    } else {
      throw new Error("Refresh token verification failed", { cause: error });
    }
  }
  // Check for reuse
  const dbToken = await refreshTokenFamilyModel.findByToken(token);
  if (!dbToken || dbToken.is_revoked) {
    // Revoke the whole family if reused
    if (decoded.familyId && decoded.userId) {
      await refreshTokenFamilyModel.revokeFamily(decoded.familyId, decoded.userId, 'reuse_detected');
    }
    throw new Error("Refresh token reuse detected. All tokens in this chain are revoked. Please re-login.");
  }
  return decoded;
}

/**
 * Checks if a token is expired without throwing an error
 * @param token - JWT token to check
 * @returns True if token is expired, false otherwise
 */
export function isTokenExpired(token: string): boolean {
  try {
    verifyToken(token);
    return false;
  } catch (error) {
    return error instanceof Error && error.message === "Token has expired";
  }
}
