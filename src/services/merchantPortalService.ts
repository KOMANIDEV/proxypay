import crypto from "crypto";
import { pool } from "../config/database";
import { isTokenRevoked, revokeToken } from "./tokenRevocationService";

// ---------------------------------------------------------------------------
// Merchant Portal URL Generation (#460)
// ---------------------------------------------------------------------------

const PORTAL_SECRET = process.env.MERCHANT_PORTAL_SECRET || process.env.JWT_SECRET || "portal-secret-fallback";
const PORTAL_BASE_URL = process.env.MERCHANT_PORTAL_URL || "https://portal.proxypay.app";
const DEFAULT_EXPIRY_SECONDS = 3600; // 1 hour

interface PortalTokenPayload {
  merchantId: string;
  email: string;
  iat: number;
  exp: number;
  jti: string;
  nonce: string;
}

interface PortalUrlResult {
  url: string;
  token: string;
  expiresAt: Date;
  merchantId: string;
}

interface MerchantPortalData {
  id: string;
  name: string;
  email: string;
  businessName?: string;
  phone?: string;
  status: string;
}

function signPayload(payload: PortalTokenPayload): string {
  const data = JSON.stringify(payload);
  const hmac = crypto.createHmac("sha256", PORTAL_SECRET);
  hmac.update(data);
  const signature = hmac.digest("hex");
  return Buffer.from(data).toString("base64url") + "." + signature;
}

export async function verifyPortalToken(token: string): Promise<PortalTokenPayload | null> {
  try {
    const [dataB64, signature] = token.split(".");
    if (!dataB64 || !signature) return null;

    const data = Buffer.from(dataB64, "base64url").toString("utf8");
    const hmac = crypto.createHmac("sha256", PORTAL_SECRET);
    hmac.update(data);
    const expectedSig = hmac.digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSig, "hex"))) {
      return null;
    }

    const payload: PortalTokenPayload = JSON.parse(data);
    if (payload.exp * 1000 < Date.now()) return null;

    // Check if token has been revoked
    const revoked = await isTokenRevoked(payload.jti);
    if (revoked) {
      console.warn(`[MerchantPortal] Token verification failed: token revoked (jti=${payload.jti})`);
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a one-time-use portal URL for a merchant.
 */
export async function generatePortalUrl(
  merchantId: string,
  options?: { expirySeconds?: number; prefill?: Partial<MerchantPortalData> },
): Promise<PortalUrlResult> {
  const expirySeconds = options?.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;

  // Fetch merchant data for pre-filling
  const result = await pool.query(
    `SELECT id, name, email, business_name, phone_number, status
     FROM merchants WHERE id = $1`,
    [merchantId],
  );

  if (result.rows.length === 0) {
    throw new Error(`Merchant not found: ${merchantId}`);
  }

  const merchant = result.rows[0];
  const now = Math.floor(Date.now() / 1000);

  const payload: PortalTokenPayload = {
    merchantId,
    email: merchant.email,
    iat: now,
    exp: now + expirySeconds,
    jti: crypto.randomUUID(),
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  const token = signPayload(payload);

  // Record the token for one-time-use enforcement
  await pool.query(
    `INSERT INTO merchant_portal_tokens (token_id, merchant_id, expires_at, used)
     VALUES ($1, $2, to_timestamp($3), false)
     ON CONFLICT (token_id) DO NOTHING`,
    [payload.jti, merchantId, payload.exp],
  );

  const expiresAt = new Date(payload.exp * 1000);

  return {
    url: `${PORTAL_BASE_URL}/session?token=${token}`,
    token,
    expiresAt,
    merchantId,
  };
}

/**
 * Validate and consume a one-time-use portal token.
 * Returns merchant data if valid, null otherwise.
 */
export async function consumePortalToken(
  token: string,
): Promise<MerchantPortalData | null> {
  const payload = verifyPortalToken(token);
  if (!payload) return null;

  // Mark token as used (atomic)
  const updateResult = await pool.query(
    `UPDATE merchant_portal_tokens
     SET used = true, used_at = NOW()
     WHERE token_id = $1 AND used = false
     RETURNING merchant_id`,
    [payload.jti],
  );

  if (updateResult.rows.length === 0) {
    // Token already used or not found
    return null;
  }

  // Fetch full merchant data
  const merchantResult = await pool.query(
    `SELECT id, name, email, business_name, phone_number, status
     FROM merchants WHERE id = $1`,
    [payload.merchantId],
  );

  if (merchantResult.rows.length === 0) return null;

  const m = merchantResult.rows[0];
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    businessName: m.business_name,
    phone: m.phone_number,
    status: m.status,
  };
}

/**
 * Rotate a merchant's portal token.
 * Generates a new token and revokes the old one.
 */
export async function rotatePortalToken(
  merchantId: string,
  oldTokenJti: string,
  oldTokenExp: number,
  options?: { expirySeconds?: number },
): Promise<PortalUrlResult> {
  // Revoke the old token immediately
  await revokeToken(
    oldTokenJti,
    merchantId,
    oldTokenExp,
    "rotation",
    "portal",
  );

  // Generate a new token
  return generatePortalUrl(merchantId, options);
}
