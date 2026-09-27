import { pool } from "../config/database";

// ─── Types ───────────────────────────────────────────────────────────────────

export type KycLevelType = "none" | "basic" | "full";
export type KycChangeSource = "user" | "admin" | "system" | "webhook";

export interface KycAuditEntry {
  id: string;
  user_id: string;
  previous_level: KycLevelType | null;
  new_level: KycLevelType;
  change_reason: string;
  changed_by: string | null;
  change_source: KycChangeSource;
  metadata: Record<string, any>;
  created_at: string;
}

export interface KycAuditReport {
  user_id: string;
  current_level: KycLevelType;
  total_changes: number;
  entries: KycAuditEntry[];
}

export interface KycAdminReport {
  date_from: string;
  date_to: string;
  total_changes: number;
  changes_by_level: Record<string, number>;
  changes_by_source: Record<string, number>;
  recent_changes: KycAuditEntry[];
}

// ─── Log KYC Status Change ───────────────────────────────────────────────────

export async function logKycStatusChange(params: {
  userId: string;
  previousLevel: KycLevelType | null;
  newLevel: KycLevelType;
  reason: string;
  changedBy?: string | null;
  source: KycChangeSource;
  metadata?: Record<string, any>;
}): Promise<KycAuditEntry> {
  const id = `kyc_audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const entry: KycAuditEntry = {
    id,
    user_id: params.userId,
    previous_level: params.previousLevel,
    new_level: params.newLevel,
    change_reason: params.reason,
    changed_by: params.changedBy ?? null,
    change_source: params.source,
    metadata: params.metadata ?? {},
    created_at: now,
  };

  await pool.query(
    `INSERT INTO kyc_audit_log
      (id, user_id, previous_level, new_level, change_reason,
       changed_by, change_source, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.id,
      entry.user_id,
      entry.previous_level,
      entry.new_level,
      entry.change_reason,
      entry.changed_by,
      entry.change_source,
      JSON.stringify(entry.metadata),
      entry.created_at,
    ],
  );

  // Create notification for the user
  await pool.query(
    `INSERT INTO kyc_notifications
      (user_id, type, message, previous_level, new_level, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.userId,
      "kyc_level_changed",
      `Your KYC level has been changed from ${params.previousLevel ?? "none"} to ${params.newLevel}. Reason: ${params.reason}`,
      params.previousLevel,
      params.newLevel,
      now,
    ],
  );

  return entry;
}

// ─── Retrieve KYC Change History ──────────────────────────────────────────────

export async function getKycChangeHistory(
  userId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<KycAuditReport> {
  const historyResult = await pool.query(
    `SELECT * FROM kyc_audit_log
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );

  const currentResult = await pool.query(
    `SELECT kyc_level FROM users WHERE id = $1`,
    [userId],
  );

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM kyc_audit_log WHERE user_id = $1`,
    [userId],
  );

  return {
    user_id: userId,
    current_level: currentResult.rows[0]?.kyc_level ?? "none",
    total_changes: countResult.rows[0].total,
    entries: historyResult.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      previous_level: row.previous_level,
      new_level: row.new_level,
      change_reason: row.change_reason,
      changed_by: row.changed_by,
      change_source: row.change_source,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      created_at: row.created_at,
    })),
  };
}

// ─── Admin Reports ────────────────────────────────────────────────────────────

export async function getKycAdminReport(params: {
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}): Promise<KycAdminReport> {
  const dateFrom = params.dateFrom ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const dateTo = params.dateTo ?? new Date().toISOString();
  const limit = params.limit ?? 100;

  const changesResult = await pool.query(
    `SELECT * FROM kyc_audit_log
     WHERE created_at >= $1 AND created_at <= $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [dateFrom, dateTo, limit],
  );

  const byLevelResult = await pool.query(
    `SELECT new_level, COUNT(*)::int AS count
     FROM kyc_audit_log
     WHERE created_at >= $1 AND created_at <= $2
     GROUP BY new_level`,
    [dateFrom, dateTo],
  );

  const bySourceResult = await pool.query(
    `SELECT change_source, COUNT(*)::int AS count
     FROM kyc_audit_log
     WHERE created_at >= $1 AND created_at <= $2
     GROUP BY change_source`,
    [dateFrom, dateTo],
  );

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM kyc_audit_log
     WHERE created_at >= $1 AND created_at <= $2`,
    [dateFrom, dateTo],
  );

  const changesByLevel: Record<string, number> = {};
  for (const row of byLevelResult.rows) {
    changesByLevel[row.new_level] = row.count;
  }

  const changesBySource: Record<string, number> = {};
  for (const row of bySourceResult.rows) {
    changesBySource[row.change_source] = row.count;
  }

  return {
    date_from: dateFrom,
    date_to: dateTo,
    total_changes: totalResult.rows[0].total,
    changes_by_level: changesByLevel,
    changes_by_source: changesBySource,
    recent_changes: changesResult.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      previous_level: row.previous_level,
      new_level: row.new_level,
      change_reason: row.change_reason,
      changed_by: row.changed_by,
      change_source: row.change_source,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      created_at: row.created_at,
    })),
  };
}
