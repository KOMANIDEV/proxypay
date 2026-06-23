import { queryRead, queryWrite } from "../config/database";
import { rabbitMQManager, EXCHANGES, ROUTING_KEYS } from "./rabbitmq";
import logger from "../utils/logger";

export interface DLQEntry {
  id: string;
  original_job_id: string | null;
  queue_name: string;
  job_name: string;
  job_data: Record<string, unknown>;
  failure_reason: string;
  attempts_made: number;
  replayed_at: string | null;
  replayed_by: string | null;
  created_at: string;
}

export interface CaptureOptions {
  originalJobId?: string;
  queueName: string;
  jobName: string;
  jobData: Record<string, unknown>;
  failureReason: string;
  attemptsMade: number;
}

/** Persists a failed job to the dead_letter_queue table. */
export async function capturePersistentFailure(opts: CaptureOptions): Promise<void> {
  const { originalJobId, queueName, jobName, jobData, failureReason, attemptsMade } = opts;
  try {
    await queryWrite(
      `INSERT INTO dead_letter_queue
         (original_job_id, queue_name, job_name, job_data, failure_reason, attempts_made)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [originalJobId ?? null, queueName, jobName, JSON.stringify(jobData), failureReason, attemptsMade],
    );
    logger.warn({ originalJobId, queueName, jobName, attemptsMade }, "[DLQ] Job captured to dead letter queue");
  } catch (err) {
    logger.error({ err, originalJobId, queueName }, "[DLQ] Failed to persist dead letter entry");
  }
}

export interface DLQQueryOptions {
  queueName?: string;
  failureReason?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Queries DLQ entries with optional filters. */
export async function queryDLQ(opts: DLQQueryOptions = {}): Promise<{ items: DLQEntry[]; total: number }> {
  const { queueName, failureReason, from, to, limit = 50, offset = 0 } = opts;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (queueName) {
    params.push(queueName);
    conditions.push(`queue_name = $${params.length}`);
  }
  if (failureReason) {
    params.push(`%${failureReason}%`);
    conditions.push(`failure_reason ILIKE $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`created_at <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await queryRead(
    `SELECT COUNT(*) FROM dead_letter_queue ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const dataResult = await queryRead(
    `SELECT * FROM dead_letter_queue ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { items: dataResult.rows as DLQEntry[], total };
}

/** Re-enqueues a DLQ entry back to RabbitMQ and marks it replayed. */
export async function replayDLQEntry(id: string, replayedBy: string): Promise<DLQEntry> {
  const result = await queryRead(
    "SELECT * FROM dead_letter_queue WHERE id = $1",
    [id],
  );

  if (!result.rows.length) {
    throw Object.assign(new Error("DLQ entry not found"), { status: 404 });
  }

  const entry = result.rows[0] as DLQEntry;

  if (entry.replayed_at) {
    throw Object.assign(new Error("DLQ entry has already been replayed"), { status: 409 });
  }

  // Re-publish to RabbitMQ using the transaction routing key.
  // Extend this mapping if other job types are introduced.
  await rabbitMQManager.publish(
    EXCHANGES.TRANSACTIONS,
    ROUTING_KEYS.TRANSACTION_PROCESS,
    entry.job_data,
  );

  await queryWrite(
    `UPDATE dead_letter_queue SET replayed_at = NOW(), replayed_by = $1 WHERE id = $2`,
    [replayedBy, id],
  );

  logger.info({ id, replayedBy, queueName: entry.queue_name }, "[DLQ] Entry replayed");
  return { ...entry, replayed_at: new Date().toISOString(), replayed_by: replayedBy };
}
