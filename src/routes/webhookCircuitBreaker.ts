/**
 * Admin endpoints for the webhook circuit breaker (#573)
 *
 * Two operations, both deliberately narrow:
 *
 *   GET  /api/admin/webhooks/circuit-breaker         — what is tripped, and when
 *   POST /api/admin/webhooks/circuit-breaker/reset   — close one destination now
 *
 * The GET half matters as much as the reset. A breaker with a 24-hour cooldown
 * is invisible from the outside: an operator looking at rising failed-delivery
 * counts has no way to tell "the endpoint is refusing us" from "the breaker is
 * holding back deliveries to an endpoint that is refusing nobody". Exposing the
 * state, the last error and the next probe time is what makes the difference
 * visible.
 *
 * The reset exists because the cooldown is a blunt instrument. If an operator
 * knows the destination was fixed at 09:00 and the breaker will not re-probe
 * until tomorrow, waiting is the wrong answer. `?url=` narrows the reset to one
 * destination; without it every destination is closed at once, which is a
 * bigger hammer than most callers want and so has to be asked for explicitly.
 *
 * Note there is an unmounted `src/routes/webhookAdmin.ts` holding an earlier,
 * unrelated set of webhook admin endpoints. It is not mounted in `src/index.ts`
 * and nothing here depends on it; wiring it up is a separate decision, not
 * something to smuggle in through a circuit-breaker change.
 */

import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { getWebhookCircuitBreaker } from "../services/webhookCircuitBreaker";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import logger from "../utils/logger";

const router = Router();

router.use(requireAuth, requireAdmin);

/**
 * The destination to operate on.
 *
 * Defaults to the configured `WEBHOOK_URL`, which is the only destination the
 * service talks to today. Accepting an explicit `url` keeps the endpoint useful
 * once per-merchant destinations exist, and lets an operator inspect a breaker
 * for a URL this process has not used yet (it reads back as `closed`, having
 * never failed).
 */
function targetUrl(req: Request): string {
  const requested = typeof req.query.url === "string" ? req.query.url.trim() : "";
  const url = requested || process.env.WEBHOOK_URL || "";
  if (!url) {
    throw createError(
      ERROR_CODES.INVALID_INPUT,
      "No webhook destination configured; pass ?url=",
      { missing: "url" },
    );
  }
  return url;
}

// GET /api/admin/webhooks/circuit-breaker
router.get("/circuit-breaker", (req: Request, res: Response, next: NextFunction) => {
  try {
    const breaker = getWebhookCircuitBreaker();
    const url = targetUrl(req);
    const snapshot = breaker.snapshot(url);

    logger.info(
      { url, state: snapshot.state, consecutiveFailures: snapshot.consecutiveFailures },
      "[webhook-circuit] state inspected",
    );

    return res.json({
      data: {
        destination: snapshot,
        // The full set, so an operator can see whether one bad endpoint is the
        // whole problem or every endpoint has started failing at once — a very
        // different incident.
        all: breaker.listSnapshots(),
      },
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/admin/webhooks/circuit-breaker/reset
router.post("/circuit-breaker/reset", (req: Request, res: Response, next: NextFunction) => {
  try {
    const breaker = getWebhookCircuitBreaker();
    const url = targetUrl(req);
    const before = breaker.snapshot(url);
    const after = breaker.reset(url);

    // Logged with the actor: a manual reset overrides an automatic protection,
    // so the audit trail has to say who decided the protection was wrong.
    logger.warn(
      {
        url,
        actor: req.jwtUser?.userId,
        previousState: before.state,
        previousFailures: before.consecutiveFailures,
        previousLastError: before.lastError,
      },
      "[webhook-circuit] manual reset by admin",
    );

    return res.json({
      data: {
        destination: after,
        previous: { state: before.state, consecutiveFailures: before.consecutiveFailures },
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
