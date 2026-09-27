/**
 * Provider Throttle Dead-Letter Queue Admin API (Issue #625)
 *
 * Provider throttle requests that would previously have been dropped when the
 * queue was full (or that exhausted all retries) are now persisted in a
 * dead-letter queue. These endpoints let operators inspect and replay them.
 *
 * All routes require an authenticated admin (`admin:system` permission).
 */
import { Router, Request, Response } from "express";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import {
  listDeadLetters,
  getDeadLetterCount,
  replayDeadLetter,
  replayAllDeadLetters,
} from "../services/mobilemoney/providerThrottle";

const router = Router();

const MAX_LIMIT = 500;

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * GET /api/admin/provider-throttle/dlq
 * List dead-lettered provider calls (newest first).
 *
 * Query params: `limit` (default 50, max 500), `offset` (default 0)
 */
router.get(
  "/dlq",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parsePositiveInt(req.query.limit, 50) || 50, MAX_LIMIT);
      const offset = parsePositiveInt(req.query.offset, 0);
      const [items, total] = await Promise.all([
        listDeadLetters(limit, offset),
        getDeadLetterCount(),
      ]);
      res.json({ success: true, data: { items, total, limit, offset } });
    } catch (error: any) {
      console.error("[ProviderThrottleAdmin] list DLQ error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to list provider throttle dead-letter items",
      });
    }
  },
);

/**
 * GET /api/admin/provider-throttle/dlq/count
 * Number of dead-lettered provider calls awaiting replay.
 */
router.get(
  "/dlq/count",
  authenticateToken,
  requirePermission("admin:system"),
  async (_req: Request, res: Response) => {
    try {
      const pending = await getDeadLetterCount();
      res.json({ success: true, data: { pending } });
    } catch (error: any) {
      console.error("[ProviderThrottleAdmin] DLQ count error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to read provider throttle dead-letter count",
      });
    }
  },
);

/**
 * POST /api/admin/provider-throttle/dlq/replay
 * Replay up to `limit` dead-lettered provider calls.
 */
router.post(
  "/dlq/replay",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const limit = Math.min(
        parsePositiveInt(req.body?.limit, 100) || 100,
        MAX_LIMIT,
      );
      const result = await replayAllDeadLetters(limit);
      res.json({ success: true, data: result });
    } catch (error: any) {
      console.error("[ProviderThrottleAdmin] DLQ replay-all error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to replay provider throttle dead-letter items",
      });
    }
  },
);

/**
 * POST /api/admin/provider-throttle/dlq/:id/replay
 * Replay a single dead-lettered provider call.
 */
router.post(
  "/dlq/:id/replay",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const result = await replayDeadLetter(req.params.id);
      if (!result.replayed) {
        res.status(400).json({ success: false, data: result, message: result.error });
        return;
      }
      res.json({ success: true, data: result });
    } catch (error: any) {
      console.error("[ProviderThrottleAdmin] DLQ replay error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to replay provider throttle dead-letter item",
      });
    }
  },
);

export default router;
