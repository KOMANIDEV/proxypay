import { Request, Response, NextFunction } from "express";
import { isTokenRevoked } from "../services/tokenRevocationService";

/**
 * Middleware to verify that portal tokens in requests haven't been revoked.
 * 
 * Checks for portal token in:
 * 1. Authorization header (Bearer token)
 * 2. x-portal-token header
 * 3. Query parameter ?token=
 * 
 * If a revoked token is detected, returns 401 Unauthorized.
 */
export async function verifyPortalTokenNotRevoked(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Extract portal token from various sources
    let token: string | null = null;
    let tokenId: string | null = null;

    // 1. Check Authorization header (Bearer scheme)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }

    // 2. Check x-portal-token header
    if (!token) {
      token = req.headers["x-portal-token"] as string | undefined || null;
    }

    // 3. Check query parameter
    if (!token) {
      token = (req.query.token as string) || null;
    }

    // If no token found, continue to next middleware
    if (!token) {
      return next();
    }

    // Extract token ID (jti) from token payload
    // Portal tokens are HMAC signed: base64url.hex
    try {
      const [dataB64] = token.split(".");
      if (dataB64) {
        const data = JSON.parse(Buffer.from(dataB64, "base64url").toString("utf8"));
        tokenId = data.jti;
      }
    } catch (error) {
      // If we can't extract jti, continue (let downstream handler validate)
      return next();
    }

    // Check if token has been revoked
    if (tokenId) {
      const revoked = await isTokenRevoked(tokenId);
      if (revoked) {
        console.warn("[PortalTokenRevocation] Rejected request with revoked token", {
          tokenId,
          path: req.path,
          method: req.method,
          ip: req.ip,
        });

        res.status(401).json({
          error: "Token has been revoked",
          message: "This token is no longer valid. Please request a new one.",
        });
        return;
      }
    }

    next();
  } catch (error) {
    console.error("[PortalTokenRevocation] Error verifying token revocation:", error);
    // On error, continue to next middleware rather than blocking
    next();
  }
}

/**
 * Attach token ID to request for audit logging.
 * Extracts the jti (token ID) from portal tokens and attaches it to the request.
 */
export async function attachPortalTokenId(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    let token: string | null = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }

    if (!token) {
      token = (req.headers["x-portal-token"] as string) || null;
    }

    if (!token) {
      token = (req.query.token as string) || null;
    }

    if (token) {
      try {
        const [dataB64] = token.split(".");
        if (dataB64) {
          const data = JSON.parse(Buffer.from(dataB64, "base64url").toString("utf8"));
          (req as any).portalTokenId = data.jti;
          (req as any).portalTokenMerchantId = data.merchantId;
        }
      } catch {
        // Silently ignore parsing errors
      }
    }

    next();
  } catch (error) {
    console.error("[PortalTokenRevocation] Error attaching token ID:", error);
    next();
  }
}
