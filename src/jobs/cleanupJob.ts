import { pool } from "../config/database";
import { TransactionModel } from "../models/transaction";

const transactionModel = new TransactionModel();

const IDEMPOTENCY_RETENTION_HOURS = parseInt(
  process.env.IDEMPOTENCY_RETENTION_HOURS || "24",
  10,
);
const IDEMPOTENCY_BATCH_SIZE = parseInt(
  process.env.IDEMPOTENCY_CLEANUP_BATCH_SIZE || "500",
  10,
);

/**
 * Cleanup Job
 * Schedule: Daily at 2:00 AM (0 2 * * *)
 * Deletes transactions older than LOG_RETENTION_DAYS (default: 90 days)
 * that are in a terminal state (completed, failed, or cancelled).
 *
 * Also purges expired idempotency keys in configurable batches to avoid
 * long-running locks on the idempotency_keys table.
 */
export async function runCleanupJob(): Promise<void> {
  const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS || "90", 10);
  const expiredKeyCount =
    await transactionModel.releaseAllExpiredIdempotencyKeys();

  const result = await pool.query(
    `DELETE FROM transactions
     WHERE status IN ('completed', 'failed', 'cancelled')
       AND created_at < NOW() - INTERVAL '${retentionDays} days'`,
  );
  const deletedCount = result?.rowCount ?? 0;

  console.log(
    `[cleanup] Deleted ${deletedCount} old transaction(s) older than ${retentionDays} days`,
  );
  console.log(
    `[cleanup] Released ${expiredKeyCount} expired idempotency key(s)`,
  );

  const startTime = Date.now();
  let totalDeleted = 0;
  let batchCount = 0;

  for (;;) {
    const batchResult = await pool.query(
      `DELETE FROM idempotency_keys
       WHERE ctid IN (
         SELECT ctid FROM idempotency_keys
         WHERE expires_at <= NOW() - INTERVAL '${IDEMPOTENCY_RETENTION_HOURS} hours'
         LIMIT $1
       )`,
      [IDEMPOTENCY_BATCH_SIZE],
    );

    const batchDeleted = batchResult?.rowCount ?? 0;
    totalDeleted += batchDeleted;
    batchCount++;

    if (batchDeleted < IDEMPOTENCY_BATCH_SIZE) break;
  }

  const durationMs = Date.now() - startTime;
  console.log(
    `[cleanup] Deleted ${totalDeleted} expired idempotency key record(s) in ${batchCount} batch(es) (${durationMs}ms, retention=${IDEMPOTENCY_RETENTION_HOURS}h, batchSize=${IDEMPOTENCY_BATCH_SIZE})`,
  );
}
