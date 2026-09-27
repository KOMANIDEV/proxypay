import { queryRead, queryWrite } from "../config/database";
import logger from "../utils/logger";

export interface WebhookRetryPolicy {
  id: string;
  merchantId: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRetryPolicyInput {
  merchantId: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
}

export interface UpdateRetryPolicyInput {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
  isActive?: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_JITTER_FACTOR = 0.2;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

const MAX_ATTEMPTS_MIN = 1;
const MAX_ATTEMPTS_MAX = 10;
const BASE_DELAY_MS_MIN = 100;
const BASE_DELAY_MS_MAX = 60000;
const MAX_DELAY_MS_MIN = 1000;
const MAX_DELAY_MS_MAX = 300000;
const JITTER_FACTOR_MIN = 0;
const JITTER_FACTOR_MAX = 1;
const BACKOFF_MULTIPLIER_MIN = 1;
const BACKOFF_MULTIPLIER_MAX = 10;

function mapRow(row: any): WebhookRetryPolicy {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    maxAttempts: row.max_attempts,
    baseDelayMs: row.base_delay_ms,
    maxDelayMs: row.max_delay_ms,
    jitterFactor: parseFloat(row.jitter_factor),
    backoffMultiplier: parseFloat(row.backoff_multiplier),
    retryableStatusCodes: row.retryable_status_codes ?? DEFAULT_RETRYABLE_STATUS_CODES,
    isActive: row.is_active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class WebhookRetryPolicyService {
  async getOrCreateDefaults(merchantId: string): Promise<WebhookRetryPolicy> {
    const existing = await this.getByMerchantId(merchantId);
    if (existing) return existing;

    return this.create({
      merchantId,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
      jitterFactor: DEFAULT_JITTER_FACTOR,
      backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
      retryableStatusCodes: DEFAULT_RETRYABLE_STATUS_CODES,
    });
  }

  async getByMerchantId(merchantId: string): Promise<WebhookRetryPolicy | null> {
    const res = await queryRead(
      "SELECT * FROM webhook_retry_policies WHERE merchant_id = $1 AND is_active = true",
      [merchantId],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async getById(id: string): Promise<WebhookRetryPolicy | null> {
    const res = await queryRead(
      "SELECT * FROM webhook_retry_policies WHERE id = $1",
      [id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async create(input: CreateRetryPolicyInput): Promise<WebhookRetryPolicy> {
    const maxAttempts = clamp(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS_MIN, MAX_ATTEMPTS_MAX);
    const baseDelayMs = clamp(input.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, BASE_DELAY_MS_MIN, BASE_DELAY_MS_MAX);
    const maxDelayMs = clamp(input.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, MAX_DELAY_MS_MIN, MAX_DELAY_MS_MAX);
    const jitterFactor = clamp(input.jitterFactor ?? DEFAULT_JITTER_FACTOR, JITTER_FACTOR_MIN, JITTER_FACTOR_MAX);
    const backoffMultiplier = clamp(input.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER, BACKOFF_MULTIPLIER_MIN, BACKOFF_MULTIPLIER_MAX);
    const retryableStatusCodes = input.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;

    const res = await queryWrite(
      `INSERT INTO webhook_retry_policies
         (merchant_id, max_attempts, base_delay_ms, max_delay_ms, jitter_factor, backoff_multiplier, retryable_status_codes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [input.merchantId, maxAttempts, baseDelayMs, maxDelayMs, jitterFactor, backoffMultiplier, retryableStatusCodes],
    );

    const policy = mapRow(res.rows[0]);
    logger.info({ merchantId: input.merchantId, policyId: policy.id }, "Webhook retry policy created");
    return policy;
  }

  async update(id: string, input: UpdateRetryPolicyInput): Promise<WebhookRetryPolicy | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.maxAttempts !== undefined) {
      fields.push(`max_attempts = $${idx++}`);
      params.push(clamp(input.maxAttempts, MAX_ATTEMPTS_MIN, MAX_ATTEMPTS_MAX));
    }
    if (input.baseDelayMs !== undefined) {
      fields.push(`base_delay_ms = $${idx++}`);
      params.push(clamp(input.baseDelayMs, BASE_DELAY_MS_MIN, BASE_DELAY_MS_MAX));
    }
    if (input.maxDelayMs !== undefined) {
      fields.push(`max_delay_ms = $${idx++}`);
      params.push(clamp(input.maxDelayMs, MAX_DELAY_MS_MIN, MAX_DELAY_MS_MAX));
    }
    if (input.jitterFactor !== undefined) {
      fields.push(`jitter_factor = $${idx++}`);
      params.push(clamp(input.jitterFactor, JITTER_FACTOR_MIN, JITTER_FACTOR_MAX));
    }
    if (input.backoffMultiplier !== undefined) {
      fields.push(`backoff_multiplier = $${idx++}`);
      params.push(clamp(input.backoffMultiplier, BACKOFF_MULTIPLIER_MIN, BACKOFF_MULTIPLIER_MAX));
    }
    if (input.retryableStatusCodes !== undefined) {
      fields.push(`retryable_status_codes = $${idx++}`);
      params.push(input.retryableStatusCodes);
    }
    if (input.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      params.push(input.isActive);
    }

    if (fields.length === 0) return this.getById(id);

    fields.push(`updated_at = NOW()`);
    params.push(id);

    const res = await queryWrite(
      `UPDATE webhook_retry_policies SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      params,
    );

    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async list(limit = 50, offset = 0): Promise<{ policies: WebhookRetryPolicy[]; total: number }> {
    const [policiesRes, countRes] = await Promise.all([
      queryRead(
        "SELECT * FROM webhook_retry_policies ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        [limit, offset],
      ),
      queryRead("SELECT COUNT(*) FROM webhook_retry_policies", []),
    ]);

    return {
      policies: policiesRes.rows.map(mapRow),
      total: parseInt(countRes.rows[0].count, 10),
    };
  }

  async delete(id: string): Promise<boolean> {
    const res = await queryWrite(
      "DELETE FROM webhook_retry_policies WHERE id = $1",
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  calculateBackoffDelay(policy: WebhookRetryPolicy, attempt: number): number {
    const exponentialDelay = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);
    const jitter = cappedDelay * policy.jitterFactor * Math.random();
    return Math.floor(cappedDelay + jitter);
  }

  isRetryableStatusCode(policy: WebhookRetryPolicy, statusCode: number): boolean {
    return policy.retryableStatusCodes.includes(statusCode);
  }

  /**
   * Returns the list of deterministic delay values (without jitter) for each attempt
   * from 0 to maxAttempts-1, using exponential backoff capped at maxDelayMs.
   */
  computeBackoffSequence(policy: WebhookRetryPolicy): number[] {
    const sequence: number[] = [];
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      const delay = Math.min(
        policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt),
        policy.maxDelayMs,
      );
      sequence.push(delay);
    }
    return sequence;
  }

  async getRetryMetrics(merchantId: string): Promise<{
    totalAttempts: number;
    successfulDeliveries: number;
    failedDeliveries: number;
    averageAttempts: number;
    policy: WebhookRetryPolicy | null;
  }> {
    const policy = await this.getByMerchantId(merchantId);

    const res = await queryRead(
      `SELECT
         COUNT(*) as total_attempts,
         COUNT(*) FILTER (WHERE status = 'delivered') as successful,
         COUNT(*) FILTER (WHERE status = 'failed') as failed,
         COALESCE(AVG(attempts), 0) as avg_attempts
       FROM webhook_delivery_logs wdl
       JOIN merchant_webhooks mw ON wdl.webhook_id = mw.id
       WHERE mw.user_id = $1
         AND wdl.created_at >= NOW() - INTERVAL '24 hours'`,
      [merchantId],
    );

    const row = res.rows[0];
    return {
      totalAttempts: parseInt(row.total_attempts, 10),
      successfulDeliveries: parseInt(row.successful, 10),
      failedDeliveries: parseInt(row.failed, 10),
      averageAttempts: parseFloat(row.avg_attempts),
      policy,
    };
  }
}

export interface RetryPolicyResult {
  delayMs: number;
  shouldRetry: boolean;
}

/**
 * Applies a WebhookRetryPolicy to a given attempt and returns the computed
 * delay with jitter and whether another retry should be made.
 *
 * @param policy - The retry policy configuration
 * @param attempt - The current attempt index (0-indexed)
 * @returns An object containing delayMs and shouldRetry
 */
export function applyRetryPolicy(
  policy: WebhookRetryPolicy,
  attempt: number,
): RetryPolicyResult {
  const exponentialDelay = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt);
  const delay = Math.min(exponentialDelay, policy.maxDelayMs);
  const finalDelay = delay * (1 + (Math.random() - 0.5) * 2 * policy.jitterFactor);
  const shouldRetry = attempt < policy.maxAttempts - 1;

  return {
    delayMs: finalDelay,
    shouldRetry,
  };
}
