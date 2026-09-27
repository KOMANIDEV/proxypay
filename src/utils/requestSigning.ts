/**
 * Request Signing Utilities — Issue #291
 *
 * Provides RSA-PSS based cryptographic request signing and verification for
 * high-value transactions.  Clients sign their requests with their RSA private
 * key; the server verifies signatures using the stored public key.
 *
 * Canonical message format (prevents replay / parameter-tampering attacks):
 *
 *   <METHOD>\n<PATH>\n<TIMESTAMP>\n<NONCE>\n<SHA-256(body)>
 *
 * Example request headers the client must supply:
 *   X-Signature:  <base64url RSA-PSS signature>
 *   X-Timestamp:  <Unix timestamp in seconds, e.g. 1700000000>
 *   X-Nonce:      <UUID v4 or 32 random hex chars>
 */

import crypto from 'crypto';
import logger from '../services/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default transaction amount (in XAF) above which signing is required. */
export const DEFAULT_SIGNING_THRESHOLD_XAF = parseInt(
  process.env.REQUEST_SIGNING_THRESHOLD || '500000',
  10,
);

/**
 * Clock-skew tolerance in seconds.
 * Requests with a timestamp older than this value are rejected.
 */
const TIMESTAMP_TOLERANCE_SECONDS = parseInt(
  process.env.REQUEST_SIGNING_TIMESTAMP_TOLERANCE || '300',
  10,
);

/** RSA key size for generated key pairs. */
const RSA_KEY_SIZE = 2048;

/** RSA-PSS hash algorithm. */
const HASH_ALGORITHM = 'SHA-256';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignatureHeaders {
  /** Base64url-encoded RSA-PSS signature. */
  'X-Signature': string;
  /** Unix timestamp (seconds) when the request was signed. */
  'X-Timestamp': string;
  /** Random nonce (prevents replay attacks). */
  'X-Nonce': string;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Canonical message builder
// ---------------------------------------------------------------------------

/**
 * Builds the canonical string that is signed / verified.
 *
 * @param method     HTTP method (upper-cased)
 * @param path       Request path including query string, e.g. /api/transactions?foo=bar
 * @param timestamp  Unix timestamp (seconds as string)
 * @param nonce      Unique random string
 * @param body       Raw request body (Buffer or string). Pass empty string for GET requests.
 */
export function buildCanonicalMessage(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer | string = '',
): string {
  const bodyBuffer =
    body instanceof Buffer ? body : Buffer.from(body, 'utf8');
  const bodyHash = crypto
    .createHash('sha256')
    .update(bodyBuffer)
    .digest('hex');

  return [method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');
}

// ---------------------------------------------------------------------------
// Signing (client-side helper)
// ---------------------------------------------------------------------------

/**
 * Signs a canonical message with an RSA-PSS private key.
 *
 * @param privateKeyPem  PEM-encoded RSA private key
 * @param message        Canonical message produced by `buildCanonicalMessage()`
 * @returns              Base64url-encoded signature
 */
export function signMessage(privateKeyPem: string, message: string): string {
  const sign = crypto.createSign(HASH_ALGORITHM);
  sign.update(message);
  sign.end();

  return sign.sign(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64url',
  );
}

/**
 * Convenience: builds signing headers for a request.
 *
 * @param privateKeyPem  Client's RSA private key (PEM)
 * @param method         HTTP method
 * @param path           Request path (with query string)
 * @param body           Request body
 * @returns              Object with X-Signature, X-Timestamp, X-Nonce headers
 */
export function buildSigningHeaders(
  privateKeyPem: string,
  method: string,
  path: string,
  body: Buffer | string = '',
): SignatureHeaders {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = buildCanonicalMessage(method, path, timestamp, nonce, body);
  const signature = signMessage(privateKeyPem, canonical);

  return {
    'X-Signature': signature,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
}

// ---------------------------------------------------------------------------
// Verification (server-side)
// ---------------------------------------------------------------------------

/**
 * Verifies an RSA-PSS signature against the canonical message.
 *
 * @param publicKeyPem  PEM-encoded RSA public key
 * @param message       Canonical message
 * @param signature     Base64url-encoded signature from X-Signature header
 * @returns             true if the signature is valid
 */
export function verifySignature(
  publicKeyPem: string,
  message: string,
  signature: string,
): boolean {
  try {
    const verify = crypto.createVerify(HASH_ALGORITHM);
    verify.update(message);
    verify.end();

    return verify.verify(
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(signature, 'base64url'),
    );
  } catch (err) {
    logger.warn({ err, msg: 'RSA signature verification threw an error' });
    return false;
  }
}

/**
 * Full signature verification including timestamp freshness check.
 *
 * @param publicKeyPem  PEM-encoded RSA public key for the requesting client
 * @param method        HTTP method
 * @param path          Request path with query string
 * @param body          Raw request body
 * @param headers       Object containing X-Signature, X-Timestamp, X-Nonce
 * @returns             VerificationResult { valid, reason }
 */
export function verifyRequest(
  publicKeyPem: string,
  method: string,
  path: string,
  body: Buffer | string,
  headers: { 'X-Signature'?: string; 'X-Timestamp'?: string; 'X-Nonce'?: string },
): VerificationResult {
  const { 'X-Signature': signature, 'X-Timestamp': timestamp, 'X-Nonce': nonce } = headers;

  if (!signature) return { valid: false, reason: 'Missing X-Signature header' };
  if (!timestamp) return { valid: false, reason: 'Missing X-Timestamp header' };
  if (!nonce) return { valid: false, reason: 'Missing X-Nonce header' };

  // Validate timestamp format
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return { valid: false, reason: 'Invalid X-Timestamp: must be a Unix timestamp (seconds)' };
  }

  // Enforce clock-skew tolerance
  const now = Math.floor(Date.now() / 1000);
  const skew = Math.abs(now - ts);
  if (skew > TIMESTAMP_TOLERANCE_SECONDS) {
    return {
      valid: false,
      reason: `Request timestamp is too old or in the future (skew: ${skew}s, tolerance: ${TIMESTAMP_TOLERANCE_SECONDS}s)`,
    };
  }

  const canonical = buildCanonicalMessage(method, path, timestamp, nonce, body);
  const valid = verifySignature(publicKeyPem, canonical, signature);

  if (!valid) {
    return { valid: false, reason: 'Signature verification failed' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Key generation helper (for provisioning / testing)
// ---------------------------------------------------------------------------

/**
 * Generates a fresh RSA-2048 key pair in PEM format.
 * Use this when onboarding a new organisation that needs request signing.
 *
 * @returns  { publicKey, privateKey } both as PEM strings
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: RSA_KEY_SIZE,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}
