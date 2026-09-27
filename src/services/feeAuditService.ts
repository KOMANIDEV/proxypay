import { pool } from "../config/database";

export interface FeeAuditRecord {
  id: string;
  transactionId: string | null;
  userId: string | null;
  provider: string | null;
  inputAmount: number;
  calculatedFee: number;
  totalAmount: number;
  strategyId: string;
  strategyName: string;
  strategyType: string;
  strategyScope: string;
  feePercentage: number | null;
  flatAmount: number | null;
  feeMinimum: number | null;
  feeMaximum: number | null;
  timeOverrideActive: boolean;
  rawFee: number;
  clampedFee: number;
  createdAt: Date;
}

export interface LogFeeAuditInput {
  transactionId?: string;
  userId?: string;
  provider?: string;
  inputAmount: number;
  calculatedFee: number;
  totalAmount: number;
  strategyId: string;
  strategyName: string;
  strategyType: string;
  strategyScope: string;
  feePercentage?: number | null;
  flatAmount?: number | null;
  feeMinimum?: number | null;
  feeMaximum?: number | null;
  timeOverrideActive: boolean;
  rawFee: number;
  clampedFee: number;
}

export class FeeAuditService {
  /**
   * Persist a fee calculation audit record.
   * Non-fatal — errors are logged but not thrown.
   */
  async logFeeCalculation(input: LogFeeAuditInput): Promise<void> {
    try {
      const query = `
        INSERT INTO fee_audit_log (
          transaction_id,
          user_id,
          provider,
          input_amount,
          calculated_fee,
          total_amount,
          strategy_id,
          strategy_name,
          strategy_type,
          strategy_scope,
          fee_percentage,
          flat_amount,
          fee_minimum,
          fee_maximum,
          time_override_active,
          raw_fee,
          clamped_fee
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `;

      await pool.query(query, [
        input.transactionId ?? null,
        input.userId ?? null,
        input.provider ?? null,
        input.inputAmount,
        input.calculatedFee,
        input.totalAmount,
        input.strategyId,
        input.strategyName,
        input.strategyType,
        input.strategyScope,
        input.feePercentage ?? null,
        input.flatAmount ?? null,
        input.feeMinimum ?? null,
        input.feeMaximum ?? null,
        input.timeOverrideActive,
        input.rawFee,
        input.clampedFee,
      ]);
    } catch (error) {
      console.error(
        `[FeeAuditService] Failed to log fee calculation: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
      // Non-fatal — do not rethrow
    }
  }

  /**
   * Retrieve fee audit records with optional filters.
   * GET /api/fees/audit endpoint will call this.
   */
  async getAuditRecords(filters: {
    transactionId?: string;
    userId?: string;
    provider?: string;
    strategyId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ records: FeeAuditRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.transactionId) {
      conditions.push(`transaction_id = $${idx++}`);
      params.push(filters.transactionId);
    }
    if (filters.userId) {
      conditions.push(`user_id = $${idx++}`);
      params.push(filters.userId);
    }
    if (filters.provider) {
      conditions.push(`provider = $${idx++}`);
      params.push(filters.provider);
    }
    if (filters.strategyId) {
      conditions.push(`strategy_id = $${idx++}`);
      params.push(filters.strategyId);
    }
    if (filters.from) {
      conditions.push(`created_at >= $${idx++}`);
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push(`created_at <= $${idx++}`);
      params.push(filters.to);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM fee_audit_log ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const dataParams = [...params, limit, offset];

    const dataResult = await pool.query(
      `SELECT
         id,
         transaction_id    AS "transactionId",
         user_id           AS "userId",
         provider,
         input_amount      AS "inputAmount",
         calculated_fee    AS "calculatedFee",
         total_amount      AS "totalAmount",
         strategy_id       AS "strategyId",
         strategy_name     AS "strategyName",
         strategy_type     AS "strategyType",
         strategy_scope    AS "strategyScope",
         fee_percentage    AS "feePercentage",
         flat_amount       AS "flatAmount",
         fee_minimum       AS "feeMinimum",
         fee_maximum       AS "feeMaximum",
         time_override_active AS "timeOverrideActive",
         raw_fee           AS "rawFee",
         clamped_fee       AS "clampedFee",
         created_at        AS "createdAt"
       FROM fee_audit_log
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      dataParams,
    );

    const records: FeeAuditRecord[] = dataResult.rows.map((row) => ({
      id: row.id,
      transactionId: row.transactionId,
      userId: row.userId,
      provider: row.provider,
      inputAmount: parseFloat(row.inputAmount),
      calculatedFee: parseFloat(row.calculatedFee),
      totalAmount: parseFloat(row.totalAmount),
      strategyId: row.strategyId,
      strategyName: row.strategyName,
      strategyType: row.strategyType,
      strategyScope: row.strategyScope,
      feePercentage: row.feePercentage != null ? parseFloat(row.feePercentage) : null,
      flatAmount: row.flatAmount != null ? parseFloat(row.flatAmount) : null,
      feeMinimum: row.feeMinimum != null ? parseFloat(row.feeMinimum) : null,
      feeMaximum: row.feeMaximum != null ? parseFloat(row.feeMaximum) : null,
      timeOverrideActive: row.timeOverrideActive,
      rawFee: parseFloat(row.rawFee),
      clampedFee: parseFloat(row.clampedFee),
      createdAt: row.createdAt,
    }));

    return { records, total };
  }
}

export const feeAuditService = new FeeAuditService();
