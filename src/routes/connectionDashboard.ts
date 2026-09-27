/**
 * #355 – Connection Pool Dashboard Route
 *
 * Express router exposing connection pool statistics and transaction
 * connection tracking for monitoring dashboards.
 */

import { Router, Request, Response } from "express";
import {
  getConnectionPoolStats,
  connectionDashboardHandler,
  scanForLongRunningTransactions,
  getTrackedTransactionCount,
} from "../middleware/transactionLeakDetector";
import { pool, writePool, checkReplicaHealth } from "../config/database";

const router = Router();

/**
 * GET /api/admin/connections
 *
 * Returns comprehensive connection pool statistics for monitoring dashboards.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const stats = getConnectionPoolStats(pool);

    // Augment with replica pool info
    const replicaHealth = await checkReplicaHealth();

    res.json({
      primary: {
        totalCount: (pool as any).totalCount || 0,
        idleCount: (pool as any).idleCount || 0,
        waitingCount: (pool as any).waitingCount || 0,
      },
      write: {
        totalCount: (writePool as any).totalCount || 0,
        idleCount: (writePool as any).idleCount || 0,
        waitingCount: (writePool as any).waitingCount || 0,
      },
      replicas: replicaHealth,
      transactions: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to retrieve connection pool stats",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/connections/transactions
 *
 * Returns detailed transaction connection tracking information.
 */
router.get("/transactions", (req: Request, res: Response) => {
  connectionDashboardHandler(req, res);
});

/**
 * GET /api/admin/connections/long-running
 *
 * Returns only long-running transaction details.
 */
router.get("/long-running", (_req: Request, res: Response) => {
  try {
    const longRunning = scanForLongRunningTransactions().map((t) => ({
      endpoint: t.endpoint,
      operation: t.operation,
      method: t.method,
      heldForMs: Date.now() - t.checkedOutAt,
      requestId: t.requestId,
    }));

    res.json({
      count: longRunning.length,
      transactions: longRunning,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to scan for long-running transactions",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/connections/summary
 *
 * Lightweight summary for quick dashboard widgets.
 */
router.get("/summary", (_req: Request, res: Response) => {
  res.json({
    activeTrackers: getTrackedTransactionCount(),
    primaryPoolTotal: (pool as any).totalCount || 0,
    primaryPoolIdle: (pool as any).idleCount || 0,
    primaryPoolWaiting: (pool as any).waitingCount || 0,
    longRunningCount: scanForLongRunningTransactions().length,
    timestamp: new Date().toISOString(),
  });
});

export default router;
