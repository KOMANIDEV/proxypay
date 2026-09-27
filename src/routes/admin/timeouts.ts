import { Router, Request, Response } from "express";
import {
  listTimeouts,
  updateTimeout,
} from "../middleware/routeTimeout";

// ---------------------------------------------------------------------------
// Admin Timeout Configuration Routes (#359)
// ---------------------------------------------------------------------------

export const adminTimeoutRoutes = Router();

/**
 * GET /admin/timeouts
 * List all timeout configurations (defaults, env override, route overrides).
 */
adminTimeoutRoutes.get("/", (req: Request, res: Response) => {
  listTimeouts(req, res);
});

/**
 * PUT /admin/timeouts
 * Update a route timeout override.
 * Body: { route: string, timeoutMs?: number }
 * If timeoutMs is omitted, the override is removed.
 */
adminTimeoutRoutes.put("/", (req: Request, res: Response) => {
  updateTimeout(req, res);
});
