/**
 * #414 Bulk Compliance Screening Routes
 *
 * POST /api/v1/compliance/bulk-screening         — submit a batch
 * GET  /api/v1/compliance/bulk-screening         — list all batches
 * GET  /api/v1/compliance/bulk-screening/:id     — get batch status
 * GET  /api/v1/compliance/bulk-screening/:id/report — full results report
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { createError } from '../middleware/errorHandler';
import { ERROR_CODES } from '../constants/errorCodes';
import {
  createBulkScreeningBatch,
  getBatch,
  getBatchReport,
  listBatches,
  ScreeningSubject,
} from '../services/bulkComplianceService';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const subjectSchema = z.object({
  ref: z.string().min(1, 'ref is required'),
  name: z.string().min(1, 'name is required'),
  country: z.string().length(2).optional(),
  address: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createBatchSchema = z.object({
  subjects: z
    .array(subjectSchema)
    .min(1, 'At least one subject is required')
    .max(10_000, 'Maximum 10,000 subjects per batch'),
  webhookUrl: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const bulkComplianceRoutes = Router();

/**
 * POST /api/v1/compliance/bulk-screening
 * Submit a batch of subjects for compliance screening.
 */
bulkComplianceRoutes.post(
  '/',
  requireAuth,
  requirePermission('compliance:write'),
  async (req: Request, res: Response) => {
    const parsed = createBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        'Validation failed',
        { details: parsed.error.flatten().fieldErrors },
      );
    }

    const { subjects, webhookUrl, metadata } = parsed.data;

    const batch = await createBulkScreeningBatch({
      subjects: subjects as ScreeningSubject[],
      webhookUrl,
      metadata,
    });

    return res.status(202).json({
      batchId: batch.batchId,
      status: batch.status,
      totalItems: batch.totalItems,
      message: 'Batch submitted. Poll status endpoint or await webhook.',
      statusUrl: `/api/v1/compliance/bulk-screening/${batch.batchId}`,
      reportUrl: `/api/v1/compliance/bulk-screening/${batch.batchId}/report`,
    });
  },
);

/**
 * GET /api/v1/compliance/bulk-screening
 * List all batches (most recent first, max 50).
 */
bulkComplianceRoutes.get(
  '/',
  requireAuth,
  requirePermission('compliance:read'),
  (_req: Request, res: Response) => {
    const batches = listBatches().slice(0, 50).map((b) => ({
      batchId: b.batchId,
      status: b.status,
      totalItems: b.totalItems,
      processedItems: b.processedItems,
      flaggedItems: b.flaggedItems,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    }));

    return res.json({ count: batches.length, batches });
  },
);

/**
 * GET /api/v1/compliance/bulk-screening/:batchId
 * Retrieve batch status (without full results — use /report for that).
 */
bulkComplianceRoutes.get(
  '/:batchId',
  requireAuth,
  requirePermission('compliance:read'),
  (req: Request, res: Response) => {
    const { batchId } = req.params;
    const batch = getBatch(batchId);

    if (!batch) {
      throw createError(ERROR_CODES.NOT_FOUND, `Batch ${batchId} not found`, {
        error: `Batch ${batchId} not found`,
      });
    }

    return res.json({
      batchId: batch.batchId,
      status: batch.status,
      totalItems: batch.totalItems,
      processedItems: batch.processedItems,
      flaggedItems: batch.flaggedItems,
      errorItems: batch.errorItems,
      completionPct:
        batch.totalItems > 0
          ? Math.round((batch.processedItems / batch.totalItems) * 100)
          : 0,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      completedAt: batch.completedAt,
    });
  },
);

/**
 * GET /api/v1/compliance/bulk-screening/:batchId/report
 * Full results report including all flagged entities.
 */
bulkComplianceRoutes.get(
  '/:batchId/report',
  requireAuth,
  requirePermission('compliance:read'),
  (req: Request, res: Response) => {
    const { batchId } = req.params;
    const report = getBatchReport(batchId);

    if (!report) {
      throw createError(ERROR_CODES.NOT_FOUND, `Batch ${batchId} not found`, {
        error: `Batch ${batchId} not found`,
      });
    }

    return res.json(report);
  },
);
