import { pool } from "../config/database";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Sep6DepositConfig {
  asset_code: string;
  deposits_enabled: boolean;
  withdrawals_enabled: boolean;
  fee_fixed: number;
  fee_percent: number;
  min_amount: number;
  max_amount: number;
  sep9_fields: Sep9FieldSpec[];
  withdraw_types: Record<string, { fields: Record<string, Sep9FieldSpec> }>;
}

export interface Sep9FieldSpec {
  field_name: string;
  field_type: "text" | "number" | "date" | "enum" | "boolean";
  description: string;
  optional: boolean;
  enum_values?: string[];
}

export interface Sep6Transaction {
  id: string;
  kind: "deposit" | "withdrawal";
  status: string;
  account: string;
  memo?: string;
  memo_type?: string;
  asset_code: string;
  amount_in?: number;
  amount_out?: number;
  fee_fixed?: number;
  fee_percent?: number;
  started_at: string;
  completed_at?: string;
  stellar_transaction_id?: string;
  external_transaction_id?: string;
  claimable_balance_id?: string;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let configCache: Sep6DepositConfig[] | null = null;
let configCacheExpiry = 0;
const CONFIG_CACHE_TTL_MS = 60_000;

async function loadConfigsFromDb(): Promise<Sep6DepositConfig[]> {
  const now = Date.now();
  if (configCache && now < configCacheExpiry) {
    return configCache;
  }

  try {
    const result = await pool.query(`
      SELECT
        sc.asset_code,
        sc.deposits_enabled,
        sc.withdrawals_enabled,
        sc.fee_fixed,
        sc.fee_percent,
        sc.min_amount,
        sc.max_amount,
        COALESCE(
          json_agg(
            json_build_object(
              'field_name', sf.field_name,
              'field_type', sf.field_type,
              'description', sf.description,
              'optional', sf.optional,
              'enum_values', sf.enum_values
            )
          ) FILTER (WHERE sf.field_name IS NOT NULL),
          '[]'
        ) AS sep9_fields,
        COALESCE(
          jsonb_object_agg(
            wt.withdraw_type,
            jsonb_build_object('fields', COALESCE(wt.fields, '{}'::jsonb))
          ) FILTER (WHERE wt.withdraw_type IS NOT NULL),
          '{}'::jsonb
        ) AS withdraw_types
      FROM sep6_asset_configs sc
      LEFT JOIN sep6_field_specs sf ON sf.asset_code = sc.asset_code
      LEFT JOIN sep6_withdraw_types wt ON wt.asset_code = sc.asset_code
      GROUP BY sc.asset_code, sc.deposits_enabled, sc.withdrawals_enabled,
               sc.fee_fixed, sc.fee_percent, sc.min_amount, sc.max_amount
      ORDER BY sc.asset_code
    `);

    configCache = result.rows.map((row) => ({
      asset_code: row.asset_code,
      deposits_enabled: row.deposits_enabled,
      withdrawals_enabled: row.withdrawals_enabled,
      fee_fixed: parseFloat(row.fee_fixed),
      fee_percent: parseFloat(row.fee_percent),
      min_amount: parseFloat(row.min_amount),
      max_amount: parseFloat(row.max_amount),
      sep9_fields: Array.isArray(row.sep9_fields) ? row.sep9_fields : [],
      withdraw_types: typeof row.withdraw_types === "object" ? row.withdraw_types : {},
    }));

    configCacheExpiry = now + CONFIG_CACHE_TTL_MS;
    return configCache!;
  } catch (error) {
    console.error("[sep6-config] Failed to load configs from DB:", error);
    return configCache ?? [];
  }
}

export function invalidateConfigCache(): void {
  configCache = null;
  configCacheExpiry = 0;
}

// ─── SEP-6 Transaction Persistence ───────────────────────────────────────────

export async function createSep6Transaction(params: {
  kind: "deposit" | "withdrawal";
  account: string;
  assetCode: string;
  memo?: string;
  memoType?: string;
}): Promise<Sep6Transaction> {
  const id = `sep6_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO sep6_transactions
      (id, kind, status, account, memo, memo_type, asset_code, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, params.kind, "pending_user_transfer_start", params.account, params.memo ?? null, params.memoType ?? null, params.assetCode, now],
  );

  return {
    id,
    kind: params.kind,
    status: "pending_user_transfer_start",
    account: params.account,
    memo: params.memo,
    memo_type: params.memoType,
    asset_code: params.assetCode,
    started_at: now,
  };
}

export async function getSep6Transaction(id: string): Promise<Sep6Transaction | null> {
  const result = await pool.query(
    `SELECT * FROM sep6_transactions WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    account: row.account,
    memo: row.memo,
    memo_type: row.memo_type,
    asset_code: row.asset_code,
    amount_in: row.amount_in ? parseFloat(row.amount_in) : undefined,
    amount_out: row.amount_out ? parseFloat(row.amount_out) : undefined,
    fee_fixed: row.fee_fixed ? parseFloat(row.fee_fixed) : undefined,
    fee_percent: row.fee_percent ? parseFloat(row.fee_percent) : undefined,
    started_at: row.started_at,
    completed_at: row.completed_at,
    stellar_transaction_id: row.stellar_transaction_id,
    external_transaction_id: row.external_transaction_id,
    claimable_balance_id: row.claimable_balance_id,
  };
}

export async function updateSep6TransactionStatus(
  id: string,
  status: string,
  extra?: Partial<Sep6Transaction>,
): Promise<void> {
  const sets = ["status = $2"];
  const values: any[] = [id, status];
  let idx = 3;

  if (extra?.completed_at) {
    sets.push(`completed_at = $${idx++}`);
    values.push(extra.completed_at);
  }
  if (extra?.stellar_transaction_id) {
    sets.push(`stellar_transaction_id = $${idx++}`);
    values.push(extra.stellar_transaction_id);
  }
  if (extra?.external_transaction_id) {
    sets.push(`external_transaction_id = $${idx++}`);
    values.push(extra.external_transaction_id);
  }
  if (extra?.amount_in !== undefined) {
    sets.push(`amount_in = $${idx++}`);
    values.push(extra.amount_in);
  }
  if (extra?.amount_out !== undefined) {
    sets.push(`amount_out = $${idx++}`);
    values.push(extra.amount_out);
  }

  await pool.query(
    `UPDATE sep6_transactions SET ${sets.join(", ")} WHERE id = $1`,
    values,
  );
}

export async function getSep6TransactionsByAccount(
  account: string,
  limit: number = 50,
): Promise<Sep6Transaction[]> {
  const result = await pool.query(
    `SELECT * FROM sep6_transactions WHERE account = $1 ORDER BY started_at DESC LIMIT $2`,
    [account, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    account: row.account,
    memo: row.memo,
    memo_type: row.memo_type,
    asset_code: row.asset_code,
    amount_in: row.amount_in ? parseFloat(row.amount_in) : undefined,
    amount_out: row.amount_out ? parseFloat(row.amount_out) : undefined,
    fee_fixed: row.fee_fixed ? parseFloat(row.fee_fixed) : undefined,
    fee_percent: row.fee_percent ? parseFloat(row.fee_percent) : undefined,
    started_at: row.started_at,
    completed_at: row.completed_at,
    stellar_transaction_id: row.stellar_transaction_id,
    external_transaction_id: row.external_transaction_id,
    claimable_balance_id: row.claimable_balance_id,
  }));
}
