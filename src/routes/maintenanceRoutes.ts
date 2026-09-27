/**
 * Admin surface for the four maintenance features shipped together:
 *
 *   #482 Automatic database optimization  – /database-optimization/*
 *   #484 Provider contract version mgmt   – /provider-versions/*
 *   #483 Transaction reversal tracking    – /transaction-reversals/*
 *   #485 ML fraud detection               – /ml-fraud/*
 *
 * Mounted behind `requireAuth` in src/index.ts.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { queryRead } from "../config/database";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { databaseOptimizationService } from "../services/databaseOptimizationService";
import {
  listProviderVersions,
  getProviderVersion,
  registerProviderVersion,
  setVersionStatus,
  validateCompatibility,
  listVersionEvents,
} from "../services/providerApiVersionService";
import {
  transactionReversalService,
} from "../services/transactionReversalService";
import { mlFraudDetectionService } from "../services/mlFraudDetectionService";

const router = Router();

// ─── #482 database optimization ──────────────────────────────────────────────

router.get(
  "/database-optimization/plan-cache",
  async (_req: Request, res: Response) => {
    const stats = await databaseOptimizationService.getPlanCacheStats();
    return res.json({ data: stats });
  },
);

router.get(
  "/database-optimization/fragmentation",
  async (req: Request, res: Response) => {
    const minSizeMb = Number(req.query.minSizeMb ?? 1);
    if (!Number.isFinite(minSizeMb) || minSizeMb < 0) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid minSizeMb");
    }
    const samples =
      await databaseOptimizationService.monitorIndexFragmentation(minSizeMb);
    return res.json({ data: samples });
  },
);

router.get("/database-optimization/dead-tuples", async (_req, res) => {
  const stats = await databaseOptimizationService.collectDeadTupleStats();
  return res.json({ data: stats });
});

router.post(
  "/database-optimization/run",
  async (_req: Request, res: Response) => {
    const report = await databaseOptimizationService.runOptimizationCycle();
    return res.json({ data: report });
  },
);

router.get("/database-optimization/runs", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
  const { rows } = await queryRead(
    `SELECT id, vacuum_analyzed, reindexed, fragmented_indexes,
            plan_cache_entries, duration_ms, status, error, created_at
       FROM database_optimization_runs
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return res.json({ data: rows });
});

// ─── #484 provider contract versions ─────────────────────────────────────────

const RegisterVersionSchema = z.object({
  provider: z.string().min(1).max(50),
  version: z.string().min(1).max(20),
  changelog: z.string().optional(),
  requestFormat: z
    .object({
      renameFields: z.record(z.string(), z.string()).optional(),
      dropFields: z.array(z.string()).optional(),
      defaults: z.record(z.string(), z.unknown()).optional(),
      header: z.record(z.string(), z.string()).optional(),
      envelope: z.string().nullable().optional(),
    })
    .optional(),
});

router.get("/provider-versions", async (req: Request, res: Response) => {
  const provider = req.query.provider as string | undefined;
  const versions = await listProviderVersions(provider);
  return res.json({ data: versions });
});

router.get(
  "/provider-versions/:provider/:version",
  async (req: Request, res: Response) => {
    const record = await getProviderVersion(
      req.params.provider,
      req.params.version,
    );
    if (!record) {
      throw createError(ERROR_CODES.NOT_FOUND, "Provider version not found");
    }
    return res.json({ data: record });
  },
);

router.post("/provider-versions", async (req: Request, res: Response) => {
  const parsed = RegisterVersionSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid request body", {
      errors: parsed.error.errors,
    });
  }
  const record = await registerProviderVersion(parsed.data);
  return res.status(201).json({ data: record });
});

const StatusSchema = z.object({
  status: z.enum(["active", "deprecated", "retired"]),
  sunsetAt: z.coerce.date().nullable().optional(),
});

router.post(
  "/provider-versions/:provider/:version/status",
  async (req: Request, res: Response) => {
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid status payload", {
        errors: parsed.error.errors,
      });
    }
    const record = await setVersionStatus(
      req.params.provider,
      req.params.version,
      parsed.data.status,
      { sunsetAt: parsed.data.sunsetAt ?? null },
    );
    if (!record) {
      throw createError(ERROR_CODES.NOT_FOUND, "Provider version not found");
    }
    return res.json({ data: record });
  },
);

router.get(
  "/provider-versions/:provider/compatibility/:version",
  async (req: Request, res: Response) => {
    const bridgeVersion = (req.query.bridgeVersion as string) || undefined;
    const result = await validateCompatibility(
      req.params.provider,
      req.params.version,
      bridgeVersion,
    );
    return res.json({ data: result });
  },
);

router.get(
  "/provider-versions/:provider/events",
  async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const events = await listVersionEvents(req.params.provider, limit);
    return res.json({ data: events });
  },
);

// ─── #483 transaction reversal audit ─────────────────────────────────────────

router.get(
  "/transaction-reversals/:transactionId",
  async (req: Request, res: Response) => {
    const reversals =
      await transactionReversalService.listReversals(req.params.transactionId);
    return res.json({ data: reversals });
  },
);

router.get(
  "/transaction-reversals/reversal/:reversalId/audit",
  async (req: Request, res: Response) => {
    const events = await transactionReversalService.getAuditTrail(
      req.params.reversalId,
    );
    return res.json({ data: events });
  },
);

router.post(
  "/transaction-reversals/reversal/:reversalId/notify",
  async (req: Request, res: Response) => {
    const delivered = await transactionReversalService.retryNotification(
      req.params.reversalId,
    );
    return res.json({ data: { delivered } });
  },
);

router.get("/transaction-reversals/pending-notifications", async (_req, res) => {
  const pending = await transactionReversalService.findUnnotifiedReversals();
  return res.json({ data: pending });
});

// ─── #485 ML fraud detection ─────────────────────────────────────────────────

router.get("/ml-fraud/metrics", async (_req: Request, res: Response) => {
  const metrics = await mlFraudDetectionService.getModelMetrics();
  return res.json({ data: metrics });
});

router.get(
  "/ml-fraud/models/:modelVersion",
  async (req: Request, res: Response) => {
    const model = await mlFraudDetectionService.getModelByVersion(
      req.params.modelVersion,
    );
    if (!model) throw createError(ERROR_CODES.NOT_FOUND, "Model not found");
    return res.json({ data: model });
  },
);

router.post("/ml-fraud/train", async (_req: Request, res: Response) => {
  const model = await mlFraudDetectionService.trainAndPromote();
  if (!model) {
    throw createError(
      ERROR_CODES.INVALID_INPUT,
      "Insufficient training data to train a model",
    );
  }
  return res.status(201).json({ data: model });
});

const FeedbackSchema = z.object({
  transactionId: z.string().optional(),
  predictionId: z.coerce.number().int().positive().optional(),
  reviewerId: z.string().min(1),
  isFraud: z.boolean(),
  notes: z.string().max(2000).optional(),
});

router.post("/ml-fraud/feedback", async (req: Request, res: Response) => {
  const parsed = FeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid feedback payload", {
      errors: parsed.error.errors,
    });
  }
  await mlFraudDetectionService.submitFeedback(parsed.data);
  return res.status(201).json({ data: { recorded: true } });
});

export default router;
