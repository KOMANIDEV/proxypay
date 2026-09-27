/**
 * #356 – Admin Routes for Read Replica Health Management
 *
 * Express router exposing endpoints to view replica health status
 * and manually disable/enable replicas.
 */

import { Router, Request, Response } from "express";
import {
  getReplicaHealthStates,
  disableReplica,
  enableReplica,
} from "../middleware/readReplicaRouting";
import { checkReplicaHealth } from "../config/database";

const router = Router();

/**
 * GET /api/admin/replicas
 *
 * Returns health status for all configured read replicas.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const states = getReplicaHealthStates();
    const liveHealth = await checkReplicaHealth();

    res.json({
      replicas: states,
      liveHealth,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to retrieve replica health",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * POST /api/admin/replicas/disable
 *
 * Manually remove a replica from rotation.
 * Body: { url: string }
 */
router.post("/disable", (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const success = disableReplica(url);
  res.json({
    success,
    url,
    message: success
      ? `Replica ${url} has been removed from rotation`
      : `Replica ${url} not found`,
  });
});

/**
 * POST /api/admin/replicas/enable
 *
 * Re-enable a previously disabled replica.
 * Body: { url: string }
 */
router.post("/enable", (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const success = enableReplica(url);
  res.json({
    success,
    url,
    message: success
      ? `Replica ${url} has been re-enabled`
      : `Replica ${url} not found`,
  });
});

export default router;
