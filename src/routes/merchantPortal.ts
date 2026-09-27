import { Router, Request, Response } from "express";
import { generatePortalUrl, consumePortalToken, rotatePortalToken, verifyPortalToken } from "../services/merchantPortalService";
import { authenticateToken } from "../middleware/auth";

// ---------------------------------------------------------------------------
// Merchant Portal URL Routes (#460)
// ---------------------------------------------------------------------------

export const merchantPortalRoutes = Router();

/**
 * POST /merchants/:id/portal-url
 * Generate a one-time-use portal URL for a merchant.
 */
merchantPortalRoutes.post(
  "/:id/portal-url",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const merchantId = req.params.id;
      const expirySeconds = req.body.expirySeconds
        ? parseInt(req.body.expirySeconds, 10)
        : undefined;

      const result = await generatePortalUrl(merchantId, { expirySeconds });

      res.json({
        portalUrl: result.url,
        expiresAt: result.expiresAt,
        merchantId: result.merchantId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      res.status(500).json({ error: "Failed to generate portal URL", message });
    }
  },
);


/**
 * POST /merchants/:id/portal-url/rotate
 * Rotate a merchant's portal token.
 * Accepts the old token and issues a new one, revokes the old.
 */
merchantPortalRoutes.post(
  "/:id/portal-url/rotate",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const merchantId = req.params.id;
      const { token, expirySeconds } = req.body as { token?: string; expirySeconds?: number };

      if (!token) {
        return res.status(400).json({ error: "Missing token to rotate" });
      }

      // Verify the old token is valid before rotating
      const oldPayload = await verifyPortalToken(token);
      if (!oldPayload) {
        return res.status(401).json({
          error: "Invalid, expired, or already revoked token",
        });
      }

      // Ensure token belongs to the merchant
      if (oldPayload.merchantId !== merchantId) {
        return res.status(403).json({
          error: "Token does not belong to this merchant",
        });
      }

      // Rotate the token (revoke old, generate new)
      const result = await rotatePortalToken(
        merchantId,
        oldPayload.jti,
        oldPayload.exp,
        { expirySeconds },
      );

      res.json({
        portalUrl: result.url,
        expiresAt: result.expiresAt,
        merchantId: result.merchantId,
        message: "Token rotated successfully",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      res.status(500).json({ error: "Failed to rotate portal token", message });
    }
  },
);
/**
 * POST /merchants/portal/session
 * Consume a one-time portal token and return merchant session data.
 */
merchantPortalRoutes.post(
  "/portal/session",
  async (req: Request, res: Response) => {
    try {
      const { token } = req.body as { token?: string };
      if (!token) {
        return res.status(400).json({ error: "Missing token" });
      }

      const merchantData = await consumePortalToken(token);
      if (!merchantData) {
        return res.status(401).json({
          error: "Invalid or expired portal token",
        });
      }

      res.json({
        merchant: merchantData,
        session: {
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      });
    } catch (error) {
      res.status(500).json({
        error: "Portal session creation failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);
