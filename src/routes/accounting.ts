import { Router, Request, Response } from "express";
import crypto from "crypto";
import {
  addSyncJob,
  getSyncJobById,
  getSyncQueueStats,
} from "../queue/syncQueue";
import { authenticateToken } from "../middleware/auth";

export const accountingRoutes = Router();

// Apply auth token validation middleware to all accounting routes
accountingRoutes.use(authenticateToken);

/**
 * POST /api/accounting/sync
 * Enqueues a QuickBooks or Xero sync job
 */
accountingRoutes.post("/sync", async (req: Request, res: Response) => {
  const { transactionId, platform, payload } = req.body;

  if (!transactionId) {
    return res
      .status(400)
      .json({ error: "Missing required parameter: transactionId" });
  }

  if (!platform || (platform !== "quickbooks" && platform !== "xero")) {
    return res
      .status(400)
      .json({ error: "platform must be either 'quickbooks' or 'xero'" });
  }

  if (!payload || typeof payload !== "object") {
    return res
      .status(400)
      .json({ error: "Missing or invalid parameter: payload" });
  }

  const syncId = crypto.randomUUID();

  try {
    const job = await addSyncJob({
      syncId,
      transactionId,
      platform,
      payload,
    });

    return res.status(202).json({
      success: true,
      message: `${platform.toUpperCase()} sync enqueued successfully.`,
      syncId,
      jobId: job.id,
      statusUrl: `/api/accounting/sync/${job.id}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: "Failed to queue sync job",
      message,
    });
  }
});

/**
 * GET /api/accounting/sync/stats
 * Retrieves sync queue statistics
 */
accountingRoutes.get("/sync/stats", async (_req: Request, res: Response) => {
  try {
    const stats = await getSyncQueueStats();
    return res.json(stats);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: "Failed to fetch sync queue stats",
      message,
    });
  }
});

/**
 * GET /api/accounting/sync/:jobId
 * Fetches status of a queued sync job
 */
accountingRoutes.get("/sync/:jobId", async (req: Request, res: Response) => {
  const { jobId } = req.params;

  try {
    const job = await getSyncJobById(jobId);

    if (!job) {
      return res.status(404).json({ error: `Sync job not found: ${jobId}` });
    }

    const state = await job.getState();
    const result = job.returnvalue;

    return res.json({
      jobId: job.id,
      status: state,
      attemptsMade: job.attemptsMade,
      data: {
        syncId: job.data.syncId,
        transactionId: job.data.transactionId,
        platform: job.data.platform,
      },
      ...(result && { result }),
      ...(job.failedReason && { failedReason: job.failedReason }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: "Failed to fetch sync job status",
      message,
    });
  }
});
