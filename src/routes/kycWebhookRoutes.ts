/**
 * #402 – KYC Webhook Callback Routes
 *
 * GET  /api/kyc/webhooks/config          – get current webhook config
 * POST /api/kyc/webhooks/config          – register / update webhook URL
 * DELETE /api/kyc/webhooks/config        – remove webhook config
 * GET  /api/kyc/webhooks/deliveries      – list delivery history
 * POST /api/kyc/webhooks/test            – send a test event
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateToken } from "../middleware/auth";
import { validateRequest } from "../middleware/validation";
import { pool } from "../config/database";
import {
  buildKYCWebhookEvent,
  deliverKYCWebhook,
  enqueueKYCWebhook,
  signWebhookPayload,
  verifyWebhookSignature,
  type KYCWebhookEvent,
} from "../services/kycWebhookService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const RegisterWebhookSchema = z.object({
  webhook_url: z
    .string()
    .url("Must be a valid URL")
    .max(2048),
  events: z
    .array(
      z.enum([
        "kyc.check.completed",
        "kyc.check.initiated",
        "kyc.document.uploaded",
        "kyc.applicant.created",
        "kyc.workflow.completed",
        "kyc.status.changed",
      ]),
    )
    .min(1)
    .optional(),
  secret: z.string().min(16).max(256).optional(),
});

// ─── GET /config ──────────────────────────────────────────────────────────────

router.get("/config", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  const { rows } = await pool.query(
    `SELECT id, webhook_url, events, active, created_at, updated_at
     FROM kyc_webhook_configs WHERE user_id = $1 LIMIT 1`,
    [userId],
  );

  if (!rows.length) return res.json({ data: null });

  res.json({ data: rows[0] });
});

// ─── POST /config ─────────────────────────────────────────────────────────────

router.post(
  "/config",
  authenticateToken,
  validateRequest(RegisterWebhookSchema),
  async (req: Request, res: Response) => {
    const userId = req.jwtUser?.userId;
    if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

    const { webhook_url, events, secret } = req.body as z.infer<typeof RegisterWebhookSchema>;

    const defaultEvents = [
      "kyc.check.completed",
      "kyc.status.changed",
      "kyc.workflow.completed",
    ];

    const { rows } = await pool.query(
      `INSERT INTO kyc_webhook_configs (user_id, webhook_url, events, secret, active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (user_id) DO UPDATE
         SET webhook_url = EXCLUDED.webhook_url,
             events      = EXCLUDED.events,
             secret      = COALESCE(EXCLUDED.secret, kyc_webhook_configs.secret),
             active      = TRUE,
             updated_at  = NOW()
       RETURNING id, webhook_url, events, active, created_at`,
      [userId, webhook_url, events ?? defaultEvents, secret ?? null],
    );

    res.status(201).json({ data: rows[0] });
  },
);

// ─── DELETE /config ───────────────────────────────────────────────────────────

router.delete("/config", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  await pool.query(
    `UPDATE kyc_webhook_configs SET active = FALSE, updated_at = NOW() WHERE user_id = $1`,
    [userId],
  );

  res.json({ success: true });
});

// ─── GET /deliveries ──────────────────────────────────────────────────────────

router.get("/deliveries", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;

  const { rows } = await pool.query(
    `SELECT id, event_type, event_id, target_url, attempt_count,
            last_attempt_at, status, http_status, error_message, created_at
     FROM kyc_webhook_deliveries
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM kyc_webhook_deliveries WHERE user_id = $1`,
    [userId],
  );

  res.json({
    data: rows,
    meta: { total: parseInt(countRows[0].count, 10), limit, offset },
  });
});

// ─── POST /test ───────────────────────────────────────────────────────────────

router.post("/test", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  // Fetch configured webhook URL
  const { rows } = await pool.query<{ webhook_url: string; secret: string | null }>(
    `SELECT webhook_url, secret FROM kyc_webhook_configs
     WHERE user_id = $1 AND active = TRUE LIMIT 1`,
    [userId],
  );

  if (!rows.length) {
    throw createError(
      ERROR_CODES.NOT_FOUND,
      "No active webhook configuration found. Register a webhook URL first.",
    );
  }

  const { webhook_url, secret } = rows[0];

  const testEvent: KYCWebhookEvent = buildKYCWebhookEvent("kyc.status.changed", {
    object_id: "test_obj_" + Date.now(),
    object_type: "applicant",
    applicant_id: "test_applicant_id",
    status: "approved",
    previous_status: "pending",
    metadata: { is_test: true },
  });

  // Deliver immediately (synchronously) so the caller sees the result
  const deliveryId = await enqueueKYCWebhook(userId, webhook_url, testEvent);

  // Fetch the queued delivery and fire it
  const { rows: deliveryRows } = await pool.query(
    `SELECT * FROM kyc_webhook_deliveries WHERE id = $1`,
    [deliveryId],
  );

  if (!deliveryRows.length) {
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to create test delivery");
  }

  await deliverKYCWebhook(deliveryRows[0] as any);

  // Fetch updated delivery status
  const { rows: updatedRows } = await pool.query(
    `SELECT id, status, http_status, error_message, attempt_count
     FROM kyc_webhook_deliveries WHERE id = $1`,
    [deliveryId],
  );

  res.json({
    success: true,
    delivery: updatedRows[0],
    event: testEvent,
    signature_header_example: signWebhookPayload(
      JSON.stringify(testEvent),
      secret ?? undefined,
    ),
  });
});

// ─── POST /verify – signature verification helper ─────────────────────────────

router.post("/verify", async (req: Request, res: Response) => {
  const signature = req.headers["x-kyc-signature"] as string | undefined;
  if (!signature) {
    return res.status(400).json({ valid: false, error: "Missing X-KYC-Signature header" });
  }

  const rawBody = JSON.stringify(req.body);
  const secret = process.env.KYC_WEBHOOK_SECRET ?? "kyc-webhook-dev-secret";
  const valid = verifyWebhookSignature(rawBody, signature, secret);

  res.json({ valid });
});

export default router;
