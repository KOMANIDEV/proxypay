/**
 * Request Signing Middleware — Issue #291
 *
 * Enforces RSA-PSS signature verification for high-value transactions.
 * Transactions whose `amount` field (in XAF) exceeds the configured threshold
 * must include valid X-Signature, X-Timestamp, and X-Nonce headers.
 *
 * Public keys are resolved per organisation/user via the `getPublicKey`
 * callback passed to `requireRequestSignature()`.  This decouples key storage
 * from the middleware — keys can be stored in the DB, Redis, or fetched from a
 * secrets manager.
 *
 * Mount order:
 *   1. express.json() / body parser — body must be parsed before this runs
 *   2. requireRequestSignature(...)
 *   3. route handler
 *
 * @example
 *   import { requireRequestSignature } from '../middleware/requestSigningMiddleware';
 *
 *   router.post(
 *     '/deposit',
 *     requireRequestSignature(async (req) => {
 *       const user = await UserModel.findById(req.user!.id);
 *       return user?.rsaPublicKey ?? null;
 *     }),
 *     depositController,
 *   );
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyRequest, DEFAULT_SIGNING_THRESHOLD_XAF } from '../utils/requestSigning';
import logger from '../services/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Async callback that resolves the RSA public key (PEM string) for the
 * requesting user/organisation, or null if no key is registered.
 */
export type PublicKeyResolver = (req: Request) => Promise<string | null>;

export interface RequestSigningOptions {
  /**
   * Minimum transaction amount (in XAF) that requires a signature.
   * Defaults to DEFAULT_SIGNING_THRESHOLD_XAF (500 000 XAF).
   */
  threshold?: number;

  /**
   * When true, all requests go through verification regardless of amount.
   * Useful for specific high-security endpoints.
   */
  alwaysRequire?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the transaction amount from the request body.
 * Returns 0 if the body does not contain a numeric `amount` field.
 */
function extractAmount(body: unknown): number {
  if (body && typeof body === 'object' && 'amount' in body) {
    const raw = (body as Record<string, unknown>).amount;
    const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw));
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Extracts the lower-cased value of a header, supporting both string and
 * string-array forms from Express.
 */
function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware that enforces RSA request signing for
 * high-value transactions.
 *
 * @param resolvePublicKey  Callback to retrieve the client's public key PEM
 * @param opts              Optional configuration overrides
 */
export function requireRequestSignature(
  resolvePublicKey: PublicKeyResolver,
  opts: RequestSigningOptions = {},
): RequestHandler {
  const threshold = opts.threshold ?? DEFAULT_SIGNING_THRESHOLD_XAF;
  const alwaysRequire = opts.alwaysRequire ?? false;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const amount = extractAmount(req.body);
      const requiresSigning = alwaysRequire || amount > threshold;

      if (!requiresSigning) {
        next();
        return;
      }

      // Resolve the client's public key
      const publicKeyPem = await resolvePublicKey(req);

      if (!publicKeyPem) {
        logger.warn({
          msg: 'Request signing required but no public key registered for user',
          path: req.path,
          amount,
          userId: (req as Request & { user?: { id?: string } }).user?.id,
        });

        res.status(403).json({
          error: 'REQUEST_SIGNING_REQUIRED',
          message:
            'This transaction requires request signing. ' +
            'Please register an RSA public key and include X-Signature, X-Timestamp, and X-Nonce headers.',
          threshold,
        });
        return;
      }

      // Read raw body for signature verification.
      // Express stores the raw body buffer on req when the `verify` option is
      // set on the body-parser.  Fall back to re-serialising the parsed body.
      const rawBody: Buffer | string =
        (req as Request & { rawBody?: Buffer }).rawBody ??
        JSON.stringify(req.body);

      const result = verifyRequest(publicKeyPem, req.method, req.originalUrl, rawBody, {
        'X-Signature': getHeader(req, 'x-signature'),
        'X-Timestamp': getHeader(req, 'x-timestamp'),
        'X-Nonce': getHeader(req, 'x-nonce'),
      });

      if (!result.valid) {
        logger.warn({
          msg: 'Request signature verification failed',
          reason: result.reason,
          path: req.path,
          amount,
        });

        res.status(401).json({
          error: 'INVALID_REQUEST_SIGNATURE',
          message: result.reason ?? 'Request signature is invalid or missing.',
        });
        return;
      }

      logger.info({
        msg: 'High-value transaction signature verified',
        path: req.path,
        amount,
        userId: (req as Request & { user?: { id?: string } }).user?.id,
      });

      next();
    } catch (err) {
      logger.error({ err, msg: 'Unexpected error in request signing middleware' });
      next(err);
    }
  };
}
