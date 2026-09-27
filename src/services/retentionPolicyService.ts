/**
 * GDPR Data Retention Policy Service
 *
 * Retention periods are configured per data type in the `retention_policies`
 * table (seeded by migration 20260730_create_retention_policies). Environment
 * variables provide the fallback used before the table is populated or when it
 * is unavailable.
 *
 * Every purge run is recorded in `retention_purge_audit` so compliance can
 * evidence that the policy was actually enforced.
 */

import { pool } from "../config/database";

export const RETENTION_DATA_TYPES = ["transactions", "logs", "pii"] as const;

export type RetentionDataType = (typeof RETENTION_DATA_TYPES)[number];

export interface RetentionPolicy {
  dataType: RetentionDataType;
  retentionDays: number;
  enabled: boolean;
}

export interface PurgeResult {
  dataType: RetentionDataType;
  retentionDays: number;
  cutoff: Date;
  recordsAffected: number;
  outcome: "success" | "failed" | "skipped";
  error?: string;
}

const DEFAULT_RETENTION_DAYS: Record<RetentionDataType, number> = {
  transactions: 2555, // 7 years
  logs: 365,
  pii: 2555,
};

const RETENTION_ENV_VARS: Record<RetentionDataType, string> = {
  transactions: "RETENTION_TRANSACTIONS_DAYS",
  logs: "RETENTION_LOGS_DAYS",
  pii: "RETENTION_PII_DAYS",
};

function defaultPolicy(dataType: RetentionDataType): RetentionPolicy {
  const configured = parseInt(
    process.env[RETENTION_ENV_VARS[dataType]] || "",
    10,
  );

  return {
    dataType,
    retentionDays: Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RETENTION_DAYS[dataType],
    enabled: true,
  };
}

function cutoffFor(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Purges a single data type. Each statement is written to be idempotent so a
 * re-run reports zero affected records rather than re-purging.
 */
async function purgeDataType(
  dataType: RetentionDataType,
  cutoff: Date,
): Promise<number> {
  switch (dataType) {
    case "transactions": {
      // Hard-delete: only terminal transactions are eligible.
      const result = await pool.query(
        `DELETE FROM transactions
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND created_at < $1`,
        [cutoff],
      );
      return result?.rowCount ?? 0;
    }
    case "logs": {
      const result = await pool.query(
        `DELETE FROM audit_logs WHERE created_at < $1`,
        [cutoff],
      );
      return result?.rowCount ?? 0;
    }
    case "pii": {
      // Soft-delete: strip PII from deactivated accounts, keep the record so
      // financial history stays referentially intact.
      const result = await pool.query(
        `UPDATE users
         SET first_name = NULL,
             last_name = NULL,
             address = NULL,
             date_of_birth = NULL,
             id_number = NULL
         WHERE is_active = false
           AND deactivated_at < $1
           AND (first_name IS NOT NULL
                OR last_name IS NOT NULL
                OR address IS NOT NULL
                OR date_of_birth IS NOT NULL
                OR id_number IS NOT NULL)`,
        [cutoff],
      );
      return result?.rowCount ?? 0;
    }
  }
}

export class RetentionPolicyService {
  /** Returns the effective policy for every known data type. */
  async getPolicies(): Promise<RetentionPolicy[]> {
    const defaults = RETENTION_DATA_TYPES.map(defaultPolicy);

    try {
      const result = await pool.query(
        `SELECT data_type, retention_days, enabled FROM retention_policies`,
      );

      return defaults.map((policy) => {
        const row = result.rows.find(
          (r: { data_type: string }) => r.data_type === policy.dataType,
        );
        if (!row) return policy;
        return {
          dataType: policy.dataType,
          retentionDays: Number(row.retention_days),
          enabled: Boolean(row.enabled),
        };
      });
    } catch (err) {
      console.warn(
        "[retention] Falling back to default policies:",
        err instanceof Error ? err.message : err,
      );
      return defaults;
    }
  }

  /** Updates (or inserts) the policy for a single data type. */
  async setPolicy(
    dataType: RetentionDataType,
    retentionDays: number,
    enabled = true,
  ): Promise<void> {
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
      throw new Error("retentionDays must be a positive integer");
    }

    await pool.query(
      `INSERT INTO retention_policies (data_type, retention_days, enabled, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (data_type) DO UPDATE
         SET retention_days = EXCLUDED.retention_days,
             enabled = EXCLUDED.enabled,
             updated_at = CURRENT_TIMESTAMP`,
      [dataType, retentionDays, enabled],
    );
  }

  /** Enforces every enabled policy, recording each outcome in the audit log. */
  async enforceAll(): Promise<PurgeResult[]> {
    const policies = await this.getPolicies();
    const results: PurgeResult[] = [];

    for (const policy of policies) {
      const cutoff = cutoffFor(policy.retentionDays);

      if (!policy.enabled) {
        results.push({
          dataType: policy.dataType,
          retentionDays: policy.retentionDays,
          cutoff,
          recordsAffected: 0,
          outcome: "skipped",
        });
        continue;
      }

      let result: PurgeResult;
      try {
        const recordsAffected = await purgeDataType(policy.dataType, cutoff);
        result = {
          dataType: policy.dataType,
          retentionDays: policy.retentionDays,
          cutoff,
          recordsAffected,
          outcome: "success",
        };
      } catch (err) {
        result = {
          dataType: policy.dataType,
          retentionDays: policy.retentionDays,
          cutoff,
          recordsAffected: 0,
          outcome: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }

      await this.recordPurge(result);
      results.push(result);
    }

    return results;
  }

  /** Returns the most recent purge audit entries, newest first. */
  async getPurgeAudit(limit = 50): Promise<unknown[]> {
    const result = await pool.query(
      `SELECT id, data_type, retention_days, cutoff_at, records_affected,
              outcome, error, executed_at
       FROM retention_purge_audit
       ORDER BY executed_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows;
  }

  private async recordPurge(result: PurgeResult): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO retention_purge_audit
           (data_type, retention_days, cutoff_at, records_affected, outcome, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          result.dataType,
          result.retentionDays,
          result.cutoff,
          result.recordsAffected,
          result.outcome,
          result.error ?? null,
        ],
      );
    } catch (err) {
      console.error(
        `[retention] Failed to write purge audit for ${result.dataType}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export const retentionPolicyService = new RetentionPolicyService();
