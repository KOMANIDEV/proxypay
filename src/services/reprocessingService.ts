import { queryRead, queryWrite } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { rabbitMQManager, EXCHANGES, ROUTING_KEYS } from "../queue/rabbitmq";
import logger from "../utils/logger";
import { withRetry } from "../services/retry";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { StellarService } from "../services/stellar/stellarService";

export interface ReprocessingPolicy {
  provider: string;
  maxAttempts: number;
  baseDelayMs: number;
  backoffStrategy: "exponential" | "linear" | "fixed";
  retryableStatuses: TransactionStatus[];
}

export interface ReprocessingJob {
  id: string;
  transactionId: string;
  provider: string;
  attemptNumber: number;
  maxAttempts: number;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  failureReason?: string;
  scheduledAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReprocessingResult {
  success: boolean;
  transactionId: string;
  attemptNumber: number;
  error?: string;
}

const DEFAULT_POLICIES: ReprocessingPolicy[] = [
  {
    provider: "mtn",
    maxAttempts: 5,
    baseDelayMs: 5000,
    backoffStrategy: "exponential",
    retryableStatuses: [TransactionStatus.Failed],
  },
  {
    provider: "airtel",
    maxAttempts: 4,
    baseDelayMs: 3000,
    backoffStrategy: "exponential",
    retryableStatuses: [TransactionStatus.Failed],
  },
  {
    provider: "orange",
    maxAttempts: 4,
    baseDelayMs: 3000,
    backoffStrategy: "exponential",
    retryableStatuses: [TransactionStatus.Failed],
  },
];

export class ReprocessingService {
  private policies: Map<string, ReprocessingPolicy> = new Map(
    DEFAULT_POLICIES.map((p) => [p.provider, p]),
  );

  async getPolicy(provider: string): Promise<ReprocessingPolicy> {
    const cached = await this.loadPolicyFromDb(provider);
    if (cached) return cached;
    const policy = this.policies.get(provider.toLowerCase()) || DEFAULT_POLICIES[0];
    return policy;
  }

  async updatePolicy(provider: string, updates: Partial<ReprocessingPolicy>): Promise<ReprocessingPolicy> {
    const existing = await this.getPolicy(provider);
    const merged: ReprocessingPolicy = { ...existing, ...updates, provider };
    this.policies.set(provider.toLowerCase(), merged);

    await queryWrite(
      `INSERT INTO reprocessing_policies (provider, max_attempts, base_delay_ms, backoff_strategy, retryable_statuses)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider) DO UPDATE SET
         max_attempts = EXCLUDED.max_attempts,
         base_delay_ms = EXCLUDED.base_delay_ms,
         backoff_strategy = EXCLUDED.backoff_strategy,
         retryable_statuses = EXCLUDED.retryable_statuses,
         updated_at = NOW()
       RETURNING *`,
      [
        merged.provider,
        merged.maxAttempts,
        merged.baseDelayMs,
        merged.backoffStrategy,
        JSON.stringify(merged.retryableStatuses),
      ],
    );

    return merged;
  }

  async enqueueFailedTransaction(transactionId: string, provider: string): Promise<ReprocessingJob> {
    const policy = await this.getPolicy(provider);
    const existing = await this.findActiveJob(transactionId);
    if (existing) {
      throw new Error(`Transaction ${transactionId} is already in reprocessing queue`);
    }

    const id = `repro-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const scheduledAt = new Date();
    const delayMs = this.calculateDelay(policy, 1);
    scheduledAt.setMilliseconds(scheduledAt.getMilliseconds() + delayMs);

    const result = await queryWrite(
      `INSERT INTO reprocessing_jobs (id, transaction_id, provider, attempt_number, max_attempts, status, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, transactionId, provider, 0, policy.maxAttempts, "pending", scheduledAt],
    );

    const job = result.rows[0] as ReprocessingJob;
    await this.publishJob(job);
    return job;
  }

  async processJob(job: ReprocessingJob): Promise<ReprocessingResult> {
    const policy = await this.getPolicy(job.provider);
    const transactionModel = new TransactionModel();
    const transaction = await transactionModel.findById(job.transactionId);

    if (!transaction) {
      return { success: false, transactionId: job.transactionId, attemptNumber: job.attemptNumber, error: "Transaction not found" };
    }

    if (!policy.retryableStatuses.includes(transaction.status as TransactionStatus)) {
      return { success: false, transactionId: job.transactionId, attemptNumber: job.attemptNumber, error: "Transaction status not retryable" };
    }

    try {
      const result = await withRetry(
        async () => {
          const mobileMoneyService = new MobileMoneyService();
          return await mobileMoneyService.retryTransaction(transaction);
        },
        {
          maxAttempts: 1,
          baseDelayMs: 0,
          provider: job.provider,
        },
      );

      await queryWrite(
        `UPDATE reprocessing_jobs SET status = 'completed', attempt_number = attempt_number + 1, processed_at = NOW(), completed_at = NOW() WHERE id = $1`,
        [job.id],
      );

      return { success: true, transactionId: job.transactionId, attemptNumber: job.attemptNumber + 1 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const shouldRetry = job.attemptNumber + 1 < policy.maxAttempts;

      await queryWrite(
        `UPDATE reprocessing_jobs SET status = $1, attempt_number = attempt_number + 1, failure_reason = $2, processed_at = NOW() WHERE id = $3`,
        [shouldRetry ? "pending" : "failed", errorMessage, job.id],
      );

      if (shouldRetry) {
        const nextDelay = this.calculateDelay(policy, job.attemptNumber + 1);
        const nextScheduledAt = new Date();
        nextScheduledAt.setMilliseconds(nextScheduledAt.getMilliseconds() + nextDelay);

        await queryWrite(`UPDATE reprocessing_jobs SET scheduled_at = $1 WHERE id = $2`, [nextScheduledAt, job.id]);
        await this.publishJob({ ...job, scheduledAt: nextScheduledAt });
      }

      return { success: false, transactionId: job.transactionId, attemptNumber: job.attemptNumber + 1, error: errorMessage };
    }
  }

  async cancelJob(jobId: string): Promise<void> {
    await queryWrite(`UPDATE reprocessing_jobs SET status = 'cancelled' WHERE id = $1`, [jobId]);
  }

  async getPendingJobs(limit = 100): Promise<ReprocessingJob[]> {
    const result = await queryRead(
      `SELECT * FROM reprocessing_jobs WHERE status = 'pending' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows as ReprocessingJob[];
  }

  async getJobStats(): Promise<{ pending: number; processing: number; completed: number; failed: number; cancelled: number }> {
    const result = await queryRead(
      `SELECT status, COUNT(*) as count FROM reprocessing_jobs GROUP BY status`,
    );
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of result.rows) {
      stats[row.status as keyof typeof stats] = parseInt(row.count, 10);
    }
    return stats;
  }

  private async loadPolicyFromDb(provider: string): Promise<ReprocessingPolicy | null> {
    const result = await queryRead(`SELECT * FROM reprocessing_policies WHERE provider = $1`, [provider.toLowerCase()]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      provider: row.provider,
      maxAttempts: row.max_attempts,
      baseDelayMs: row.base_delay_ms,
      backoffStrategy: row.backoff_strategy,
      retryableStatuses: row.retryable_statuses,
    };
  }

  private async findActiveJob(transactionId: string): Promise<ReprocessingJob | null> {
    const result = await queryRead(
      `SELECT * FROM reprocessing_jobs WHERE transaction_id = $1 AND status IN ('pending', 'processing')`,
      [transactionId],
    );
    return result.rows[0] || null;
  }

  private calculateDelay(policy: ReprocessingPolicy, attempt: number): number {
    if (policy.backoffStrategy === "exponential") {
      return policy.baseDelayMs * Math.pow(2, attempt - 1);
    }
    if (policy.backoffStrategy === "linear") {
      return policy.baseDelayMs * attempt;
    }
    return policy.baseDelayMs;
  }

  private async publishJob(job: ReprocessingJob): Promise<void> {
    await rabbitMQManager.publish(EXCHANGES.TRANSACTIONS, ROUTING_KEYS.TRANSACTION_PROCESS, {
      type: "reprocessing",
      jobId: job.id,
      transactionId: job.transactionId,
      provider: job.provider,
      attemptNumber: job.attemptNumber,
      scheduledAt: job.scheduledAt,
    });
  }
}

export const reprocessingService = new ReprocessingService();
