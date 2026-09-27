/**
 * #414 Bulk Compliance Screening Service
 *
 * Provides batch sanctions / AML compliance screening with:
 *  - Bulk submission and tracking
 *  - Per-item and aggregate result reporting
 *  - Status polling for large batches
 *  - Webhook notification on batch completion
 */

import * as crypto from 'crypto';
import { pool } from '../config/database';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkScreeningStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export type ItemScreeningResult = 'clear' | 'flagged' | 'error';

export interface ScreeningSubject {
  /** Caller-supplied identifier so results can be correlated */
  ref: string;
  name: string;
  /** ISO-3166-1 alpha-2 country code */
  country?: string;
  /** Stellar / wallet address */
  address?: string;
  /** Additional free-form metadata */
  metadata?: Record<string, unknown>;
}

export interface ScreeningItemResult {
  ref: string;
  result: ItemScreeningResult;
  /** Matched sanctions entity name if flagged */
  matchedEntity?: string;
  /** Match confidence score 0–1 */
  score?: number;
  /** Source list that produced the match */
  source?: string;
  errorMessage?: string;
  screenedAt: string;
}

export interface BulkScreeningBatch {
  batchId: string;
  status: BulkScreeningStatus;
  totalItems: number;
  processedItems: number;
  flaggedItems: number;
  errorItems: number;
  webhookUrl?: string;
  results: ScreeningItemResult[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateBatchInput {
  subjects: ScreeningSubject[];
  /** Optional URL to POST results to when screening completes */
  webhookUrl?: string;
  /** Caller metadata */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// In-memory batch store (replace with DB in production)
// ---------------------------------------------------------------------------

const batchStore = new Map<string, BulkScreeningBatch>();

// Exported for testing
export function _clearBatchStore() {
  batchStore.clear();
}

export function getBatch(batchId: string): BulkScreeningBatch | undefined {
  return batchStore.get(batchId);
}

export function listBatches(): BulkScreeningBatch[] {
  return Array.from(batchStore.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Screening logic (stub — integrate with real sanctions service)
// ---------------------------------------------------------------------------

/**
 * Screen a single subject against the sanctions list.
 * Replace the stub below with a call to `sanctionService.checkParties(...)`.
 */
async function screenSubject(
  subject: ScreeningSubject,
): Promise<ScreeningItemResult> {
  const now = new Date().toISOString();
  try {
    // Minimal sanction check: look for exact/fuzzy name match in DB
    const { rows } = await pool.query<{
      name: string;
      source: string;
    }>(
      `SELECT name, source
         FROM sanctions
        WHERE LOWER(name) = LOWER($1)
           OR SIMILARITY(name, $1) > 0.7
        LIMIT 1`,
      [subject.name],
    );

    if (rows.length > 0) {
      return {
        ref: subject.ref,
        result: 'flagged',
        matchedEntity: rows[0].name,
        score: 0.9,
        source: rows[0].source,
        screenedAt: now,
      };
    }

    return { ref: subject.ref, result: 'clear', score: 0, screenedAt: now };
  } catch (err) {
    // If DB screening fails (e.g. table missing in tests), return clear
    console.error(`[bulk-compliance] screening error for ${subject.ref}:`, err);
    return {
      ref: subject.ref,
      result: 'error',
      errorMessage:
        err instanceof Error ? err.message : 'Screening unavailable',
      screenedAt: now,
    };
  }
}

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

async function deliverWebhook(
  webhookUrl: string,
  batch: BulkScreeningBatch,
): Promise<void> {
  try {
    const payload = {
      event: 'bulk_screening.completed',
      batchId: batch.batchId,
      status: batch.status,
      summary: {
        totalItems: batch.totalItems,
        flaggedItems: batch.flaggedItems,
        errorItems: batch.errorItems,
        completedAt: batch.completedAt,
      },
    };

    await axios.post(webhookUrl, payload, {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    console.info(
      `[bulk-compliance] webhook delivered — batchId: ${batch.batchId}`,
    );
  } catch (err) {
    console.error(
      `[bulk-compliance] webhook delivery failed — batchId: ${batch.batchId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

/**
 * Process a batch asynchronously.
 * Updates batch state in the store as items are screened.
 */
async function processBatch(batchId: string): Promise<void> {
  const batch = batchStore.get(batchId);
  if (!batch) return;

  batch.status = 'processing';
  batch.updatedAt = new Date().toISOString();

  // Retrieve subjects from a temporary parallel map
  const subjects = batchSubjects.get(batchId) ?? [];

  let flaggedItems = 0;
  let errorItems = 0;

  for (const subject of subjects) {
    const itemResult = await screenSubject(subject);
    batch.results.push(itemResult);
    batch.processedItems++;

    if (itemResult.result === 'flagged') flaggedItems++;
    if (itemResult.result === 'error') errorItems++;

    batch.flaggedItems = flaggedItems;
    batch.errorItems = errorItems;
    batch.updatedAt = new Date().toISOString();
  }

  batch.status = batch.errorItems === batch.totalItems ? 'failed' : 'completed';
  batch.completedAt = new Date().toISOString();
  batch.updatedAt = batch.completedAt;

  batchStore.set(batchId, batch);
  batchSubjects.delete(batchId);

  // Fire webhook if configured
  if (batch.webhookUrl) {
    await deliverWebhook(batch.webhookUrl, batch);
  }
}

/** Temporary store for subjects while batch is being processed */
const batchSubjects = new Map<string, ScreeningSubject[]>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and start processing a bulk screening batch.
 * Returns immediately — poll `getBatch(batchId)` for status.
 */
export async function createBulkScreeningBatch(
  input: CreateBatchInput,
): Promise<BulkScreeningBatch> {
  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();

  const batch: BulkScreeningBatch = {
    batchId,
    status: 'pending',
    totalItems: input.subjects.length,
    processedItems: 0,
    flaggedItems: 0,
    errorItems: 0,
    webhookUrl: input.webhookUrl,
    results: [],
    createdAt: now,
    updatedAt: now,
  };

  batchStore.set(batchId, batch);
  batchSubjects.set(batchId, input.subjects);

  // Start processing asynchronously (do not await)
  setImmediate(() => processBatch(batchId).catch(console.error));

  return { ...batch };
}

/**
 * Return a summary report for a batch.
 */
export function getBatchReport(batchId: string) {
  const batch = batchStore.get(batchId);
  if (!batch) return null;

  const flaggedRefs = batch.results
    .filter((r) => r.result === 'flagged')
    .map((r) => ({ ref: r.ref, matchedEntity: r.matchedEntity, score: r.score, source: r.source }));

  return {
    batchId: batch.batchId,
    status: batch.status,
    summary: {
      totalItems: batch.totalItems,
      processedItems: batch.processedItems,
      clearItems: batch.results.filter((r) => r.result === 'clear').length,
      flaggedItems: batch.flaggedItems,
      errorItems: batch.errorItems,
      completionPct:
        batch.totalItems > 0
          ? Math.round((batch.processedItems / batch.totalItems) * 100)
          : 0,
    },
    flaggedEntities: flaggedRefs,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    completedAt: batch.completedAt,
  };
}
