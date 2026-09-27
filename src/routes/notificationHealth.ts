/**
 * #479 – Real-Time Notification System Status
 *
 * GET  /api/notifications/status           – aggregate status for load balancers
 * GET  /api/notifications/health/channels  – per-channel health breakdown
 * GET  /api/notifications/analytics        – delivery analytics over a window
 * GET  /api/notifications/deliveries       – recent delivery attempts
 * POST /api/notifications/health/refresh   – force a fresh evaluation
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateToken } from "../middleware/auth";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { queryRead } from "../config/database";
import {
  getSystemStatus,
  getChannelHealth,
  getDeliveryAnalytics,
  snapshotChannelHealth,
} from "../services/notificationHealthService";

const router = Router();

const WindowSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(24 * 30)
  .default(24);

/**
 * Aggregate status. Returns 503 when the notification system is down so a
 * load balancer or uptime monitor can act on it without parsing the body.
 */
router.get("/status", async (req: Request, res: Response) => {
  const parsed = WindowSchema.safeParse(req.query.windowHours);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid windowHours");
  }

  const status = await getSystemStatus(parsed.data);
  return res.status(status.status === "down" ? 503 : 200).json(status);
});

router.get("/health/channels", async (req: Request, res: Response) => {
  const parsed = WindowSchema.safeParse(req.query.windowHours);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid windowHours");
  }

  const channels = await getChannelHealth(parsed.data);
  return res.json({ data: channels, meta: { windowHours: parsed.data } });
});

router.get("/analytics", async (req: Request, res: Response) => {
  const parsed = WindowSchema.safeParse(req.query.windowHours);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid windowHours");
  }

  const analytics = await getDeliveryAnalytics(parsed.data);
  return res.json({ data: analytics });
});

router.get("/deliveries", authenticateToken, async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

  const { rows } = await queryRead(
    `SELECT id, notification_key, channel, category, severity, user_id,
            transaction_id, status, duration_ms, error_message,
            created_at, delivered_at
       FROM notification_deliveries
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );

  return res.json({ data: rows, meta: { limit } });
});

router.post("/health/refresh", authenticateToken, async (_req, res) => {
  const channels = await snapshotChannelHealth();
  const status = await getSystemStatus();
  return res.json({ data: { channels, status } });
});

export default router;
