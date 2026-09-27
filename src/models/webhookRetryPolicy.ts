import { pool } from "../config/database";

export interface WebhookRetryPolicy {
  id: string;
  merchantId: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterFactor: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookRetryPolicyInput {
  merchantId: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitterFactor?: number;
  enabled?: boolean;
}

export class WebhookRetryPolicyModel {
  async create(input: WebhookRetryPolicyInput): Promise<WebhookRetryPolicy> {
    const query = `
      INSERT INTO webhook_retry_policies (
        merchant_id, max_attempts, base_delay_ms, max_delay_ms,
        multiplier, jitter_factor, enabled
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (merchant_id) DO UPDATE SET
        max_attempts = EXCLUDED.max_attempts,
        base_delay_ms = EXCLUDED.base_delay_ms,
        max_delay_ms = EXCLUDED.max_delay_ms,
        multiplier = EXCLUDED.multiplier,
        jitter_factor = EXCLUDED.jitter_factor,
        enabled = EXCLUDED.enabled,
        updated_at = CURRENT_TIMESTAMP
      RETURNING
        id,
        merchant_id AS "merchantId",
        max_attempts AS "maxAttempts",
        base_delay_ms AS "baseDelayMs",
        max_delay_ms AS "maxDelayMs",
        multiplier,
        jitter_factor AS "jitterFactor",
        enabled,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, [
      input.merchantId,
      input.maxAttempts ?? 3,
      input.baseDelayMs ?? 500,
      input.maxDelayMs ?? 30000,
      input.multiplier ?? 2.0,
      input.jitterFactor ?? 0.2,
      input.enabled ?? true,
    ]);

    return this.mapRow(result.rows[0]);
  }

  async findByMerchantId(merchantId: string): Promise<WebhookRetryPolicy | null> {
    const query = `
      SELECT
        id,
        merchant_id AS "merchantId",
        max_attempts AS "maxAttempts",
        base_delay_ms AS "baseDelayMs",
        max_delay_ms AS "maxDelayMs",
        multiplier,
        jitter_factor AS "jitterFactor",
        enabled,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM webhook_retry_policies
      WHERE merchant_id = $1
    `;

    const result = await pool.query(query, [merchantId]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async list(): Promise<WebhookRetryPolicy[]> {
    const query = `
      SELECT
        id,
        merchant_id AS "merchantId",
        max_attempts AS "maxAttempts",
        base_delay_ms AS "baseDelayMs",
        max_delay_ms AS "maxDelayMs",
        multiplier,
        jitter_factor AS "jitterFactor",
        enabled,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM webhook_retry_policies
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query);
    return result.rows.map((row) => this.mapRow(row));
  }

  async update(merchantId: string, input: Partial<WebhookRetryPolicyInput>): Promise<WebhookRetryPolicy | null> {
    const sets: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (input.maxAttempts !== undefined) {
      sets.push(`max_attempts = $${paramIndex++}`);
      params.push(input.maxAttempts);
    }
    if (input.baseDelayMs !== undefined) {
      sets.push(`base_delay_ms = $${paramIndex++}`);
      params.push(input.baseDelayMs);
    }
    if (input.maxDelayMs !== undefined) {
      sets.push(`max_delay_ms = $${paramIndex++}`);
      params.push(input.maxDelayMs);
    }
    if (input.multiplier !== undefined) {
      sets.push(`multiplier = $${paramIndex++}`);
      params.push(input.multiplier);
    }
    if (input.jitterFactor !== undefined) {
      sets.push(`jitter_factor = $${paramIndex++}`);
      params.push(input.jitterFactor);
    }
    if (input.enabled !== undefined) {
      sets.push(`enabled = $${paramIndex++}`);
      params.push(input.enabled);
    }

    if (sets.length === 0) return this.findByMerchantId(merchantId);

    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(merchantId);

    const query = `
      UPDATE webhook_retry_policies
      SET ${sets.join(", ")}
      WHERE merchant_id = $${paramIndex}
      RETURNING
        id,
        merchant_id AS "merchantId",
        max_attempts AS "maxAttempts",
        base_delay_ms AS "baseDelayMs",
        max_delay_ms AS "maxDelayMs",
        multiplier,
        jitter_factor AS "jitterFactor",
        enabled,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, params);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async delete(merchantId: string): Promise<boolean> {
    const query = `DELETE FROM webhook_retry_policies WHERE merchant_id = $1`;
    const result = await pool.query(query, [merchantId]);
    return (result.rowCount ?? 0) > 0;
  }

  private mapRow(row: any): WebhookRetryPolicy {
    return {
      id: row.id,
      merchantId: row.merchantId,
      maxAttempts: row.maxAttempts,
      baseDelayMs: row.baseDelayMs,
      maxDelayMs: row.maxDelayMs,
      multiplier: parseFloat(row.multiplier),
      jitterFactor: parseFloat(row.jitterFactor),
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
