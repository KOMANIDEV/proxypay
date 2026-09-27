import { pool } from "../config/database";

/**
 * Audit event metadata passed alongside the required userId and reason.
 */
export interface AuditEventMetadata {
  /** HTTP request method (GET, POST, etc.) */
  method?: string;
  /** Full request path */
  path?: string;
  /** Client IP address */
  ipAddress?: string;
  /** Client User-Agent header */
  userAgent?: string;
  /** Arbitrary structured data attached to the event */
  extra?: Record<string, unknown>;
}

/**
 * Persist an audit event to the `audit_logs` table.
 *
 * @param userId  – ID of the user performing the action
 * @param reason  – Short identifier for the event (e.g. "RIGHT_TO_BE_FORGOTTEN_EXECUTED")
 * @param meta    – Optional request context and extra metadata
 */
export const logAuditEvent = async (
  userId: string,
  reason: string,
  meta?: AuditEventMetadata,
): Promise<void> => {
  try {
    const query = `
      INSERT INTO audit_logs (admin_id, action, resource, resource_id, diff, ip_address, user_agent, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `;

    const diff = meta?.extra ? JSON.stringify(meta.extra) : null;

    await pool.query(query, [
      userId,
      reason,
      "user",
      userId,
      diff,
      meta?.ipAddress ?? null,
      meta?.userAgent ?? null,
    ]);
  } catch (error) {
    console.error("[AuditLog] Failed to write audit event:", {
      userId,
      reason,
      error,
    });
  }
};

/**
 * Query audit log entries for a given user, ordered by most recent first.
 *
 * @param userId – user to fetch events for
 * @param limit  – max rows to return (default 100)
 * @param offset – row offset for pagination (default 0)
 * @returns Array of audit log rows
 */
export const queryAuditEvents = async (
  userId: string,
  limit: number = 100,
  offset: number = 0,
): Promise<Record<string, unknown>[]> => {
  try {
    const query = `
      SELECT id, admin_id AS "userId", action, resource, diff, ip_address AS "ipAddress",
             user_agent AS "userAgent", created_at AS "timestamp"
      FROM audit_logs
      WHERE admin_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [userId, limit, offset]);
    return result.rows;
  } catch (error) {
    console.error("[AuditLog] Failed to query audit events:", {
      userId,
      error,
    });
    return [];
  }
};

/**
 * `resource_id` is a VARCHAR(255) column while bulk operations can touch up to
 * 100 records, so the id list is truncated there and kept in full inside `diff`.
 */
const AUDIT_RESOURCE_ID_MAX_LENGTH = 255;

/**
 * Description of a bulk admin operation that must be persisted to `audit_logs`.
 */
export interface BulkAdminAuditInput {
  /** Admin performing the operation. */
  adminId: string;
  /** Action identifier, e.g. `BULK_FREEZE_USERS`. */
  action: string;
  /** Resource type the action applied to, e.g. `user` or `transaction`. */
  resource: string;
  /** IDs of the records the operation touched. */
  resourceIds: string[];
  /** Structured description of the change that was applied. */
  changes?: Record<string, unknown>;
  /** Operator supplied justification, when the endpoint requires one. */
  reason?: string;
  /** Client IP address. */
  ipAddress?: string | null;
  /** Client User-Agent header. */
  userAgent?: string | null;
}

/**
 * Persist a bulk admin action to the `audit_logs` table.
 *
 * Unlike {@link logAuditEvent}, which tracks a single subject, this records the
 * whole batch in one row: the affected ids (and a count) live in `diff` so the
 * operation stays queryable regardless of how many records it touched.
 *
 * Audit failures are logged and swallowed — a broken audit sink must never fail
 * the admin operation itself.
 */
export const logBulkAdminAudit = async (
  input: BulkAdminAuditInput,
): Promise<void> => {
  try {
    const diff = {
      affectedCount: input.resourceIds.length,
      affectedIds: input.resourceIds,
      changes: input.changes ?? {},
      ...(input.reason ? { reason: input.reason } : {}),
    };

    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, resource, resource_id, diff, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        input.adminId,
        input.action,
        input.resource,
        input.resourceIds.join(",").slice(0, AUDIT_RESOURCE_ID_MAX_LENGTH) ||
          null,
        JSON.stringify(diff),
        input.ipAddress ?? null,
        input.userAgent ?? null,
      ],
    );
  } catch (error) {
    console.error("[AuditLog] Failed to write bulk audit event:", {
      adminId: input.adminId,
      action: input.action,
      error,
    });
  }
};

/**
 * Searchable filters exposed by the admin audit log viewer.
 */
export interface AuditLogFilters {
  /** Exact admin/user id that performed the action. */
  adminId?: string;
  /** Case-insensitive partial match on the action name. */
  action?: string;
  /** Exact resource type (e.g. `user`, `transaction`). */
  resource?: string;
  /** Partial match on the stored resource id list. */
  resourceId?: string;
  /** Inclusive lower bound (ISO-8601) on `created_at`. */
  from?: string;
  /** Inclusive upper bound (ISO-8601) on `created_at`. */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogSearchResult {
  logs: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

const MAX_AUDIT_LOG_LIMIT = 200;
const DEFAULT_AUDIT_LOG_LIMIT = 50;

/**
 * Query `audit_logs` with the filters supported by the admin dashboard viewer.
 *
 * @returns The matching rows (newest first) plus the unpaginated total.
 */
export const searchAuditLogs = async (
  filters: AuditLogFilters = {},
): Promise<AuditLogSearchResult> => {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.adminId) {
    params.push(filters.adminId);
    conditions.push(`admin_id = $${params.length}`);
  }
  if (filters.action) {
    params.push(`%${filters.action}%`);
    conditions.push(`action ILIKE $${params.length}`);
  }
  if (filters.resource) {
    params.push(filters.resource);
    conditions.push(`resource = $${params.length}`);
  }
  if (filters.resourceId) {
    params.push(`%${filters.resourceId}%`);
    conditions.push(`resource_id LIKE $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`created_at <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(
    Math.max(filters.limit ?? DEFAULT_AUDIT_LOG_LIMIT, 1),
    MAX_AUDIT_LOG_LIMIT,
  );
  const offset = Math.max(filters.offset ?? 0, 0);

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM audit_logs ${where}`,
    params,
  );

  const rowsResult = await pool.query(
    `SELECT id, admin_id AS "adminId", action, resource,
            resource_id AS "resourceId", diff, ip_address AS "ipAddress",
            user_agent AS "userAgent", created_at AS "timestamp"
     FROM audit_logs
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    logs: rowsResult.rows,
    total: Number(totalResult.rows[0]?.total ?? 0),
    limit,
    offset,
  };
};
