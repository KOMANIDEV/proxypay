/**
 * #357 – Transaction Idempotency Key Cleanup Job
 *
 * Scheduled job that purges expired idempotency keys from the database.
 * Supports configurable retention (default 24h), batch deletion, and
 * emits monitoring metrics.
 */

import { pool } from "../config/database";
import logger from "../utils/logger";
import { Counter, Histogram, Gauge, register } from "prom-client";

// ─── Prometheus Metrics ───────────────────────────────────────────────────────

export const idempotencyKeysPurgedTotal = new Counter({
  name: "idempotency_keys_purged_total",
  help: "Total number of idempotency keys purged by the cleanup job",
  registers: [register],
});

export const idempotencyCleanupDurationSeconds = new Histogram({
  name: "idempotency_cleanup_duration_seconds",
  help: "Duration of the idempotency key cleanup job in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const idempotencyKeysRemaining = new Gauge({
  name: "idempotency_keys_remaining",
  help: "Number of active (non-expired) idempotency keys after cleanup",
  registers: [register],
});

export const idempotencyCleanupErrorsTotal = new Counter({
  name: "idempotency_cleanup_errors_total",
  help: "Total number of errors during idempotency key cleanup",
  labelNames: ["error_type"],
  registers: [register],
});

export const idempotencyKeysByState = new Gauge({
  name: "idempotency_keys_by_state",
  help: "Number of idempotency keys grouped by state",
  labelNames: ["state"],
  registers: [register],
});

// ─── Configuration ────────────────────────────────────────────────────────────

const IDEMPOTENCY_TTL_HOURS = parseInt(
  process.env.IDEMPOTENCY_KEY_TTL_HOURS || "24",
  10,
);

const BATCH_SIZE = parseInt(
  process.env.IDEMPOTENCY_CLEANUP_BATCH_SIZE || "500",
  10,
);

const CLEANUP_CRON = process.env.IDEMPOTENCY_CLEANUP_CRON || "0 3 * * *";

// ─── Core Cleanup Logic ──────────────────────────────────────────────────────

/**
 * Purge expired idempotency keys in batches.
 * Returns the total number of keys deleted.
 */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const timer = idempotencyCleanupDurationSeconds.startTimer();
  let totalPurged = 0;

  try {
    // Phase 1: Delete expired keys in batches
    let deletedBatch: number;
    do {
      const result = await pool.query(
        `DELETE FROM idempotency_keys
         WHERE ctid IN (
           SELECT ctid FROM idempotency_keys
           WHERE expires_at <= CURRENT_TIMESTAMP
           LIMIT $1
         )`,
        [BATCH_SIZE],
      );

      deletedBatch = result.rowCount ?? 0;
      totalPurged += deletedBatch;

      if (deletedBatch > 0) {
        logger.debug({
          type: "idempotency_cleanup_batch",
          deleted: deletedBatch,
          totalPurged,
        });
      }
    } while (deletedBatch === BATCH_SIZE); // Continue if we hit the batch limit

    idempotencyKeysPurgedTotal.inc(totalPurged);

    // Phase 2: Record remaining key counts for monitoring
    const remainingResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'in_progress') AS in_progress,
         COUNT(*) FILTER (WHERE state = 'completed') AS completed,
         COUNT(*) AS total
       FROM idempotency_keys
       WHERE expires_at > CURRENT_TIMESTAMP`,
    );

    const row = remainingResult.rows[0];
    if (row) {
      idempotencyKeysRemaining.set(parseInt(row.total || "0", 10));
      idempotencyKeysByState.labels("in_progress").set(parseInt(row.in_progress || "0", 10));
      idempotencyKeysByState.labels("completed").set(parseInt(row.completed || "0", 10));
    }

    // Phase 3: Log summary
    logger.info({
      type: "idempotency_cleanup_complete",
      totalPurged,
      retentionHours: IDEMPOTENCY_TTL_HOURS,
      remainingKeys: row ? parseInt(row.total || "0", 10) : 0,
    });

    return totalPurged;
  } catch (err) {
    idempotencyCleanupErrorsTotal.labels({ error_type: "delete_failure" }).inc();
    logger.error({
      type: "idempotency_cleanup_error",
      error: err instanceof Error ? err.message : String(err),
      totalPurged,
    });
    throw err;
  } finally {
    timer();
  }
}

/**
 * Also clean up orphaned in_progress keys older than the TTL.
 * These represent requests that started but never completed (crash, timeout, etc.).
 */
export async function purgeStaleInProgressKeys(): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM idempotency_keys
       WHERE state = 'in_progress'
         AND created_at < NOW() - ($1 || ' hours')::INTERVAL`,
      [String(IDEMPOTENCY_TTL_HOURS)],
    );

    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      logger.warn({
        type: "idempotency_stale_in_progress_purged",
        deleted,
        retentionHours: IDEMPOTENCY_TTL_HOURS,
      });
      idempotencyKeysPurgedTotal.inc(deleted);
    }

    return deleted;
  } catch (err) {
    idempotencyCleanupErrorsTotal.labels({ error_type: "stale_progress_failure" }).inc();
    logger.error({
      type: "idempotency_stale_progress_cleanup_error",
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// ─── Job Entry Point ──────────────────────────────────────────────────────────

export async function runIdempotencyCleanupJob(): Promise<void> {
  logger.info({
    type: "idempotency_cleanup_job_start",
    retentionHours: IDEMPOTENCY_TTL_HOURS,
    batchSize: BATCH_SIZE,
  });

  const expiredPurged = await purgeExpiredIdempotencyKeys();
  const stalePurged = await purgeStaleInProgressKeys();

  logger.info({
    type: "idempotency_cleanup_job_complete",
    expiredPurged,
    stalePurged,
    totalPurged: expiredPurged + stalePurged,
  });
}

export { CLEANUP_CRON };
