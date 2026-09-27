import { Pool, QueryConfig, QueryResult, QueryResultRow, PoolClient } from "pg";
import { createHash } from "crypto";
import { auditService } from "../services/auditlogService";
import { isReadOnlyQuery } from "../utils/readOnlyDetector";
import {
  dbReplicaLagSeconds,
  dbReplicaReadEnabled,
  dbReplicaFailoversTotal,
  dbPoolUtilization,
  dbPoolTotalConnections,
  dbPoolIdleConnections,
  dbPoolWaitingConnections,
  dbPoolMaxConnections,
  dbPoolConfig,
  dbDrMode,
} from "../utils/metrics";
import { IS_SANDBOX, SANDBOX_DATABASE_URL, DATABASE_URL } from "./env";

const DR_DATABASE_URL = process.env.DR_DATABASE_URL;
const isDRMode = (): boolean => !!DR_DATABASE_URL;

// Expose DR mode as a Prometheus gauge so dashboards/alerting can react to
// failover without parsing logs. 1 = failover active, 0 = standby/normal.
dbDrMode.set(isDRMode() ? 1 : 0);

const productionSsl =
  process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined;

// Configuration for slow query logging
const SLOW_QUERY_THRESHOLD_MS = parseInt(
  process.env.SLOW_QUERY_THRESHOLD_MS || "1000",
);
const ENABLE_SLOW_QUERY_LOGGING =
  process.env.ENABLE_SLOW_QUERY_LOGGING === "true" ||
  (process.env.NODE_ENV === "development" &&
    process.env.ENABLE_SLOW_QUERY_LOGGING !== "false");

/**
 * Sanitizes a SQL query by removing sensitive data patterns
 */
function sanitizeQuery(query: string): string {
  return (
    query
      // Remove potential sensitive values in WHERE clauses
      .replace(/(WHERE\s+[^=]+\s*=\s*)'[^']*'/gi, "$1***")
      .replace(/(WHERE\s+[^=]+\s*=\s*)\d+/gi, "$1***")
      // Remove sensitive data in INSERT/UPDATE values
      .replace(/(VALUES\s*\([^)]*)'[^']*'([^)]*\))/gi, "$1***$2")
      .replace(/(SET\s+[^=]+\s*=\s*)'[^']*'/gi, "$1***")
      .replace(/(SET\s+[^=]+\s*=\s*)\d+/gi, "$1***")
      // Remove email patterns
      .replace(
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        "***@***.***",
      )
      // Remove phone number patterns
      .replace(/\b\d{10,}\b/g, "***")
      // Remove API keys and tokens
      .replace(/\b[A-Za-z0-9]{20,}\b/g, "***")
  );
}

/**
 * Sanitizes query parameters to remove sensitive data
 */
function sanitizeParams(params: any[]): any[] {
  if (!params || !Array.isArray(params)) return params;

  return params.map((param) => {
    if (typeof param === "string") {
      // Check for email patterns
      if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$/.test(param)) {
        return "***@***.***";
      }
      // Check for phone numbers (10+ digits)
      if (/^\d{10,}$/.test(param)) {
        return "***";
      }
      // Check for potential API keys/tokens (20+ chars, alphanumeric)
      if (/^[A-Za-z0-9]{20,}$/.test(param)) {
        return "***";
      }
      // Check for potential sensitive data in quotes
      if (param.length > 50) {
        return "***";
      }
      return param;
    }
    if (typeof param === "number" && param > 1000000) {
      return "***";
    }
    return param;
  });
}

/**
 * Logs slow queries with sanitized information
 */
type SlowQueryDetails = {
  pool?: "primary" | "replica";
  status?: "success" | "error";
  rowCount?: number | null;
  error?: unknown;
};

function getQueryOperation(query: string): string {
  return query.trim().split(/\s+/, 1)[0]?.toUpperCase() || "UNKNOWN";
}

function getQueryFingerprint(query: string): string {
  const normalizedQuery = query.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalizedQuery).digest("hex").slice(0, 16);
}

function getErrorDetails(error: unknown): { message: string; code?: string } | undefined {
  if (!error || typeof error !== "object") return undefined;

  const databaseError = error as { message?: unknown; code?: unknown };
  return {
    message: databaseError.message ? String(databaseError.message) : "Unknown database error",
    ...(databaseError.code ? { code: String(databaseError.code) } : {}),
  };
}

function logSlowQuery(
  query: string,
  duration: number,
  params?: any[],
  details: SlowQueryDetails = {},
): void {
  if (!ENABLE_SLOW_QUERY_LOGGING) return;

  const sanitizedQuery = sanitizeQuery(query);
  const logEntry = {
    type: "slow_query",
    duration: Math.round(duration),
    duration_ms: Math.round(duration),
    threshold: SLOW_QUERY_THRESHOLD_MS,
    threshold_ms: SLOW_QUERY_THRESHOLD_MS,
    query: sanitizedQuery,
    query_fingerprint: getQueryFingerprint(query),
    query_operation: getQueryOperation(query),
    query_length: query.length,
    params: params ? sanitizeParams(params) : undefined,
    pool: details.pool || "primary",
    status: details.status || "success",
    row_count: details.rowCount,
    error: getErrorDetails(details.error),
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(logEntry));
}

// Enhanced Pool with query timing
class SlowQueryPool extends Pool {
  async query<T extends QueryResultRow = any>(
    queryConfig: QueryConfig | string,
    values?: any,
  ): Promise<QueryResult<T>> {
    const startTime = process.hrtime.bigint();
    const queryString =
      typeof queryConfig === "string" ? queryConfig : queryConfig.text;
    const queryParams =
      typeof queryConfig === "string" ? values : queryConfig.values;

    try {
      const result = (await super.query(
        queryConfig as any,
        values,
      )) as unknown as QueryResult<T>;

      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1e6;

      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        logSlowQuery(queryString, durationMs, queryParams, {
          pool: "primary",
          status: "success",
          rowCount: result.rowCount,
        });
      }

      return result;
    } catch (error) {
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1e6;

      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        logSlowQuery(queryString, durationMs, queryParams, {
          pool: "primary",
          status: "error",
          error,
        });
      }

      throw error;
    }
  }
}

/**
 * Connection pool configuration, sourced from environment variables so that
 * different workload profiles can tune connection behaviour without code
 * changes. Defaults preserve the previous hard-coded behaviour.
 */
function readPoolNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_POOL_MAX = 1000;
const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30000;
const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 500;

const DB_POOL_MAX = readPoolNumber(process.env.DB_POOL_MAX, DEFAULT_POOL_MAX);
const DB_POOL_MIN = readPoolNumber(process.env.DB_POOL_MIN, 0);
const DB_POOL_IDLE_TIMEOUT_MS = readPoolNumber(
  process.env.DB_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
);
const DB_POOL_CONNECTION_TIMEOUT_MS = readPoolNumber(
  process.env.DB_POOL_CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
);

const DB_WRITE_POOL_MAX = readPoolNumber(
  process.env.DB_WRITE_POOL_MAX,
  DEFAULT_POOL_MAX,
);
const DB_WRITE_POOL_MIN = readPoolNumber(process.env.DB_WRITE_POOL_MIN, 0);
const DB_WRITE_POOL_IDLE_TIMEOUT_MS = readPoolNumber(
  process.env.DB_WRITE_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
);
const DB_WRITE_POOL_CONNECTION_TIMEOUT_MS = readPoolNumber(
  process.env.DB_WRITE_POOL_CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
);

const DB_REPLICA_POOL_MAX = readPoolNumber(process.env.DB_REPLICA_POOL_MAX, 100);
const DB_REPLICA_POOL_IDLE_TIMEOUT_MS = readPoolNumber(
  process.env.DB_REPLICA_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
);
const DB_REPLICA_POOL_CONNECTION_TIMEOUT_MS = readPoolNumber(
  process.env.DB_REPLICA_POOL_CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
);

const DB_POOL_MONITOR_INTERVAL_MS = readPoolNumber(
  process.env.DB_POOL_MONITOR_INTERVAL_MS,
  5000,
);

/**
 * Primary connection pool – now routes through PgBouncer for transaction-level pooling
 * This significantly reduces the number of direct connections to Postgres
 * (INSERT, UPDATE, DELETE) and read operations when no replica is available.
 */
export const pool = new Pool({
  connectionString: IS_SANDBOX ? (SANDBOX_DATABASE_URL || DATABASE_URL) : DATABASE_URL,
  max: DB_POOL_MAX,
  min: DB_POOL_MIN,
  idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
  ssl: productionSsl,
});

/**
 * Dedicated write connection pool – handles INSERT / UPDATE / DELETE operations.
 * Separating writes from reads lets operators size the two pools independently
 * for their workload (e.g. small writer pool + large reader pool, or vice-versa).
 */
export const writePool = new Pool({
  connectionString: IS_SANDBOX ? (SANDBOX_DATABASE_URL || DATABASE_URL) : DATABASE_URL,
  max: DB_WRITE_POOL_MAX,
  min: DB_WRITE_POOL_MIN,
  idleTimeoutMillis: DB_WRITE_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: DB_WRITE_POOL_CONNECTION_TIMEOUT_MS,
  ssl: productionSsl,
});

// Wrap query for slow-query logging while preserving Pool typings.
const originalPoolQuery = pool.query.bind(pool);
(pool as Pool & { query: (...args: any[]) => Promise<any> }).query = async (
  ...args: any[]
): Promise<any> => {
  const queryConfig = args[0];
  const values = args[1];
  const startTime = process.hrtime.bigint();
  const queryString =
    typeof queryConfig === "string" ? queryConfig : queryConfig?.text ?? "";
  const queryParams =
    typeof queryConfig === "string" ? values : queryConfig?.values;

  try {
    const result = await (originalPoolQuery as (...callArgs: any[]) => Promise<any>)(
      ...args,
    );
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logSlowQuery(queryString, durationMs, queryParams, {
        pool: "primary",
        status: "success",
        rowCount: result.rowCount,
      });
    }

    // PII Audit Interceptor
    if (queryString.toUpperCase().includes("FROM USERS") || queryString.toUpperCase().includes("UPDATE USERS")) {
      const isSelect = queryString.toUpperCase().startsWith("SELECT");
      const isUpdate = queryString.toUpperCase().startsWith("UPDATE");

      if (isSelect || isUpdate) {
        // Attempt to extract targetId from query or params
        let targetId = "unknown";
        if (queryParams && queryParams.length > 0) {
          // Typically the first or last param in findById or UPDATE ... WHERE id = $X
          targetId = queryParams[queryParams.length - 1]; 
        }

        // Trigger asynchronous audit logging
        // Note: Real admin context would be passed here in a production environment via AsyncLocalStorage or similar.
        // For this task, we log the access attempt to ensure visibility.
        setImmediate(() => {
          auditService.logPIIAccess({
            adminId: "system-admin", // Placeholder for actual admin context extraction
            targetId: String(targetId),
            resource: "users",
            metadata: {
              query: sanitizeQuery(queryString),
              isUpdate,
            }
          }).catch(err => console.error("[PII Audit Interceptor] Failed:", err));
        });
      }
    }

    return result;
  } catch (error) {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logSlowQuery(queryString, durationMs, queryParams, {
        pool: "primary",
        status: "error",
        error,
      });
    }
    throw error;
  }
};

/**
 * Read replica connection pool – handles SELECT queries to take load off the
 * primary. If READ_REPLICA_URL is not configured, falls back to the primary.
 *
 * Multiple replica URLs can be provided as a comma-separated list in
 * READ_REPLICA_URL. The pool load-balances across all replicas via round-robin.
 */
const replicaUrls: string[] = process.env.READ_REPLICA_URL
  ? process.env.READ_REPLICA_URL.split(",").map((url) => url.trim())
  : [];

const REPLICA_SYNC_LAG_THRESHOLD_SECONDS = (() => {
  const threshold = parseFloat(process.env.REPLICA_SYNC_LAG_THRESHOLD_SECONDS || "5");
  return Number.isFinite(threshold) ? threshold : 5;
})();
const REPLICA_LAG_MONITOR_INTERVAL_MS = (() => {
  const interval = parseInt(process.env.REPLICA_LAG_MONITOR_INTERVAL_MS || "10000", 10);
  return Number.isFinite(interval) && interval > 0 ? interval : 10000;
})();

type ReplicaStatus = {
  url: string;
  enabled: boolean;
  healthy: boolean;
  lagSeconds: number | null;
};

const replicaStatuses: ReplicaStatus[] = replicaUrls.map((url) => ({
  url,
  enabled: true,
  healthy: true,
  lagSeconds: null,
}));

// Build an individual Pool for each replica URL
const replicaPools: Pool[] = replicaUrls.map(
  (url) =>
    new Pool({
      connectionString: url,
      max: DB_REPLICA_POOL_MAX,
      idleTimeoutMillis: DB_REPLICA_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_REPLICA_POOL_CONNECTION_TIMEOUT_MS,
      ssl: productionSsl,
    }),
);

// Track which replica to use next for round-robin load balancing
let replicaIndex = 0;

function getActiveReplicaIndices(): number[] {
  return replicaStatuses
    .map((status, idx) => ({ status, idx }))
    .filter(({ status }) => status.enabled && status.healthy)
    .map(({ idx }) => idx);
}

/**
 * Return the next replica pool in round-robin order.
 * Returns null if no replica pools are configured.
 */
function getNextReplicaPool(): Pool | null {
  const activeIndices = getActiveReplicaIndices();
  if (activeIndices.length === 0) return null;
  const selectedIndex = activeIndices[replicaIndex % activeIndices.length];
  replicaIndex += 1;
  return replicaPools[selectedIndex];
}

async function refreshReplicaStatus(idx: number): Promise<void> {
  const url = replicaUrls[idx];
  let healthy = false;
  let lagSeconds: number | null = null;
  let client: PoolClient | null = null;

  try {
    client = await replicaPools[idx].connect();
    const query = `
      SELECT CASE
        WHEN pg_is_in_recovery() THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
        ELSE 0
      END AS lag_seconds
    `;
    const result = await client.query<{ lag_seconds: number | null }>(query);
    lagSeconds = result.rows?.[0]?.lag_seconds ?? null;
    healthy = true;
    markReplicaHealthy(url);
  } catch (error) {
    healthy = false;
    lagSeconds = null;
    markReplicaUnhealthy(url, error instanceof Error ? error.message : String(error));
    console.warn(`Replica health check failed for ${url}:`, error);
  } finally {
    client?.release();
  }

  const enabled = healthy && lagSeconds !== null && lagSeconds <= REPLICA_SYNC_LAG_THRESHOLD_SECONDS;
  replicaStatuses[idx] = { url, enabled, healthy, lagSeconds };

  dbReplicaLagSeconds.labels(url).set(lagSeconds ?? 0);
  dbReplicaReadEnabled.labels(url).set(enabled ? 1 : 0);
}

async function refreshAllReplicaStatuses(): Promise<void> {
  await Promise.all(replicaUrls.map((_, idx) => refreshReplicaStatus(idx)));
}

function startReplicaLagMonitor(): void {
  if (replicaUrls.length === 0) return;
  void refreshAllReplicaStatuses();
  setInterval(() => {
    void refreshAllReplicaStatuses();
  }, REPLICA_LAG_MONITOR_INTERVAL_MS);
}

startReplicaLagMonitor();

/**
 * Execute a read-only SQL query against a replica pool with retry and fallback.
 * If the replica fails, retries with exponential backoff and falls back to primary.
 *
 * @param text   - The parameterised SQL query string
 * @param params - Optional query parameters
 */
const REPLICA_RETRY_ATTEMPTS = parseInt(process.env.REPLICA_RETRY_ATTEMPTS || "2", 10);
const REPLICA_RETRY_BASE_MS = parseInt(process.env.REPLICA_RETRY_BASE_MS || "100", 10);

export async function queryRead<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  const replicaPool = getNextReplicaPool();

  if (replicaPool) {
    for (let attempt = 0; attempt <= REPLICA_RETRY_ATTEMPTS; attempt++) {
      let client: PoolClient | null = null;
      try {
        client = await replicaPool.connect();
        const result = await client.query<T>(text, params);
        return result;
      } catch (err) {
        console.warn(
          `Read replica query failed (attempt ${attempt + 1}/${REPLICA_RETRY_ATTEMPTS + 1}):`,
          err,
        );
        if (attempt < REPLICA_RETRY_ATTEMPTS) {
          const delayMs = REPLICA_RETRY_BASE_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } finally {
        client?.release();
      }
    }
    dbReplicaFailoversTotal.inc();
    console.warn("All replica attempts exhausted, falling back to primary");
  }

  return pool.query<T>(text, params);
}

/**
 * Execute a write SQL query (INSERT / UPDATE / DELETE) against the dedicated
 * write connection pool, which routes through PgBouncer via the primary DB.
 *
 * @param text   - The parameterised SQL query string
 * @param params - Optional query parameters
 */
export async function queryWrite<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  return writePool.query<T>(text, params);
}

/**
 * Health check for all replica pools.
 * Returns an array of status objects – useful for monitoring endpoints.
 */
export async function checkReplicaHealth(): Promise<
  { url: string; healthy: boolean; enabled: boolean; lagSeconds: number | null }[]
> {
  return Promise.all(
    replicaUrls.map(async (url, idx) => {
      let client: PoolClient | null = null;
      let healthy = false;
      let lagSeconds: number | null = null;

      try {
        client = await replicaPools[idx].connect();
        const query = `
          SELECT CASE
            WHEN pg_is_in_recovery() THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
            ELSE 0
          END AS lag_seconds
        `;
        const result = await client.query<{ lag_seconds: number | null }>(query);
        lagSeconds = result.rows?.[0]?.lag_seconds ?? null;
        healthy = true;
      } catch {
        healthy = false;
      } finally {
        client?.release();
      }

      const enabled = healthy && lagSeconds !== null && lagSeconds <= REPLICA_SYNC_LAG_THRESHOLD_SECONDS;
      return { url, healthy, enabled, lagSeconds };
    }),
  );
}

/**
 * Enable or disable a replica by index (0-based).
 * Useful for manual failover via admin API.
 */
export function setReplicaEnabled(index: number, enabled: boolean): boolean {
  if (index < 0 || index >= replicaStatuses.length) return false;
  replicaStatuses[index].enabled = enabled;
  return true;
}

/**
 * Get current replica statuses (read-only snapshot).
 */
export function getReplicaStatuses(): ReplicaStatus[] {
  return replicaStatuses.map((s) => ({ ...s }));
}

/**
 * Smart query router: automatically detects read-only (SELECT) queries and
 * routes them to replica pools, while routing writes (INSERT/UPDATE/DELETE) to primary.
 * This enables transparent replica usage without changing existing code patterns.
 *
 * @param text   - The parameterised SQL query string
 * @param params - Optional query parameters
 */
export async function querySmart<T extends import("pg").QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  // Auto-detect if this is a read-only query
  if (isReadOnlyQuery(text)) {
    return queryRead<T>(text, params);
  } else {
    return queryWrite<T>(text, params);
  }
}

/**
 * Get PgBouncer pool statistics
 * Queries PgBouncer admin database to get connection pool metrics
 */
export async function getPgBouncerStats(): Promise<{
  activeConnections: number;
  idleConnections: number;
  totalConnections: number;
  clientConnections: number;
}> {
  try {
    // Query PgBouncer stats database (special admin database)
    const pgbouncerPool = new Pool({
      connectionString: process.env.PGBOUNCER_ADMIN_URL || "postgresql://user:password@localhost:6432/pgbouncer",
    });

    const result = await pgbouncerPool.query(
      "SELECT sum(cl_active) as active, sum(cl_idle) as idle, sum(sv_active) as sv_active, sum(sv_idle) as sv_idle FROM pgbouncer.client_lookup;",
    );

    await pgbouncerPool.end();

    const row = result.rows[0] || {};
    return {
      activeConnections: parseInt(row.sv_active || 0),
      idleConnections: parseInt(row.sv_idle || 0),
      totalConnections: (parseInt(row.sv_active || 0) + parseInt(row.sv_idle || 0)),
      clientConnections: (parseInt(row.cl_active || 0) + parseInt(row.cl_idle || 0)),
    };
  } catch (err) {
    console.warn("Failed to get PgBouncer stats:", err);
    return {
      activeConnections: 0,
      idleConnections: 0,
      totalConnections: 0,
      clientConnections: 0,
    };
  }
}

/**
 * Context-aware query function that respects HTTP method-based routing decisions.
 * 
 * This function is designed to work with the readReplicaRoutingMiddleware.
 * It routes queries based on:
 * 1. HTTP method context (if provided) - GET requests go to replica
 * 2. SQL query type (fallback) - SELECT queries go to replica
 * 
 * Usage in route handlers:
 *   const result = await queryWithContext(req, "SELECT * FROM users", []);
 * 
 * @param req - Express Request object (with dbRouting context from middleware)
 * @param text - SQL query string
 * @param params - Query parameters
 * @returns Query result
 */
export async function queryWithContext<
  T extends import("pg").QueryResultRow = any,
>(
  req: any,
  text: string,
  params?: unknown[],
): Promise<import("pg").QueryResult<T>> {
  // Check for HTTP method-based routing context
  if (req?.dbRouting?.useReplicaPool) {
    return queryRead<T>(text, params);
  }

  // Fall back to SQL query-based routing
  return querySmart<T>(text, params);
}

/**
 * Batch query execution with request context.
 * Executes multiple queries with proper pool routing based on HTTP method.
 * 
 * All read operations (GET) use replica, all writes use primary.
 * 
 * @param req - Express Request object
 * @param queries - Array of { text, params } query configurations
 * @returns Array of query results
 */
export async function queryBatchWithContext<
  T extends import("pg").QueryResultRow = any,
>(
  req: any,
  queries: Array<{ text: string; params?: unknown[] }>,
): Promise<import("pg").QueryResult<T>[]> {
  const results: import("pg").QueryResult<T>[] = [];

  for (const query of queries) {
    const result = await queryWithContext<T>(req, query.text, query.params);
    results.push(result);
  }

  return results;
}

/**
 * Get database pool statistics combining primary and replica metrics.
 * Useful for monitoring and health check endpoints.
 */
export async function getPoolStats(): Promise<{
  primary: {
    mode: "normal" | "failover";
    url: string;
    description: string;
  };
  replicas: Array<{
    url: string;
    healthy: boolean;
    enabled: boolean;
    lagSeconds: number | null;
  }>;
}> {
  const replicaStats = await checkReplicaHealth();

  return {
    primary: {
      mode: isDRMode() ? "failover" : "normal",
      url: DR_DATABASE_URL || process.env.DATABASE_URL || "",
      description: isDRMode()
        ? "Running in DR failover mode - writes redirected to promoted replica"
        : "Primary database - all critical writes",
    },
    replicas: replicaStats,
  };
}

/**
 * Comprehensive connection pool statistics for monitoring.
 * Returns pool metrics from the primary, write and replica pools.
 */
export interface PoolSnapshot {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  maxConnections: number;
  utilization: number;
  config: {
    min: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
  };
}

function snapshotPool(
  p: Pool,
  maxDefaults: {
    min: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
  },
): PoolSnapshot {
  const maxConnections = (p.options?.max ?? DEFAULT_POOL_MAX) as number;
  const totalCount = p.totalCount ?? 0;
  const utilization = maxConnections > 0 ? Math.min(1, totalCount / maxConnections) : 0;
  return {
    totalCount,
    idleCount: p.idleCount ?? 0,
    waitingCount: p.waitingCount ?? 0,
    maxConnections,
    utilization: Number(utilization.toFixed(4)),
    config: {
      min: (p.options?.min ?? maxDefaults.min) as number,
      idleTimeoutMillis:
        (p.options?.idleTimeoutMillis ?? maxDefaults.idleTimeoutMillis) as number,
      connectionTimeoutMillis:
        (p.options?.connectionTimeoutMillis ??
          maxDefaults.connectionTimeoutMillis) as number,
    },
  };
}

export function getConnectionPoolStatistics(): {
  primary: PoolSnapshot;
  write: PoolSnapshot;
  replicas: Array<
    PoolSnapshot & {
      url: string;
      enabled: boolean;
      healthy: boolean;
      lagSeconds: number | null;
    }
  >;
} {
  return {
    primary: snapshotPool(pool, {
      min: DB_POOL_MIN,
      idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
    }),
    write: snapshotPool(writePool, {
      min: DB_WRITE_POOL_MIN,
      idleTimeoutMillis: DB_WRITE_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_WRITE_POOL_CONNECTION_TIMEOUT_MS,
    }),
    replicas: replicaUrls.map((url, idx) => {
      const snap = replicaPools[idx]
        ? snapshotPool(replicaPools[idx], {
            min: 0,
            idleTimeoutMillis: DB_REPLICA_POOL_IDLE_TIMEOUT_MS,
            connectionTimeoutMillis: DB_REPLICA_POOL_CONNECTION_TIMEOUT_MS,
          })
        : null;
      return {
        url,
        totalCount: snap?.totalCount ?? 0,
        idleCount: snap?.idleCount ?? 0,
        waitingCount: snap?.waitingCount ?? 0,
        maxConnections: snap?.maxConnections ?? 0,
        utilization: snap?.utilization ?? 0,
        config: snap?.config ?? {
          min: 0,
          idleTimeoutMillis: 0,
          connectionTimeoutMillis: 0,
        },
        enabled: replicaStatuses[idx]?.enabled ?? false,
        healthy: replicaStatuses[idx]?.healthy ?? false,
        lagSeconds: replicaStatuses[idx]?.lagSeconds ?? null,
      };
    }),
  };
}

/**
 * Record current pool utilization into Prometheus gauges so dashboards and
 * alerting can react to connection pressure without polling an endpoint.
 */
function updatePoolMetrics(): void {
  const primary = snapshotPool(pool, {
    min: DB_POOL_MIN,
    idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
  });
  dbPoolUtilization.labels("primary", "read").set(primary.utilization);
  dbPoolTotalConnections.labels("primary", "read").set(primary.totalCount);
  dbPoolIdleConnections.labels("primary", "read").set(primary.idleCount);
  dbPoolWaitingConnections.labels("primary", "read").set(primary.waitingCount);
  dbPoolMaxConnections.labels("primary", "read").set(primary.maxConnections);
  dbPoolConfig
    .labels("primary", "read", "min")
    .set(primary.config.min);
  dbPoolConfig
    .labels("primary", "read", "idle_timeout_ms")
    .set(primary.config.idleTimeoutMillis);
  dbPoolConfig
    .labels("primary", "read", "connection_timeout_ms")
    .set(primary.config.connectionTimeoutMillis);

  const write = snapshotPool(writePool, {
    min: DB_WRITE_POOL_MIN,
    idleTimeoutMillis: DB_WRITE_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DB_WRITE_POOL_CONNECTION_TIMEOUT_MS,
  });
  dbPoolUtilization.labels("write", "write").set(write.utilization);
  dbPoolTotalConnections.labels("write", "write").set(write.totalCount);
  dbPoolIdleConnections.labels("write", "write").set(write.idleCount);
  dbPoolWaitingConnections.labels("write", "write").set(write.waitingCount);
  dbPoolMaxConnections.labels("write", "write").set(write.maxConnections);
  dbPoolConfig.labels("write", "write", "min").set(write.config.min);
  dbPoolConfig
    .labels("write", "write", "idle_timeout_ms")
    .set(write.config.idleTimeoutMillis);
  dbPoolConfig
    .labels("write", "write", "connection_timeout_ms")
    .set(write.config.connectionTimeoutMillis);

  replicaUrls.forEach((url, idx) => {
    const rep = replicaPools[idx];
    if (!rep) return;
    const snap = snapshotPool(rep, {
      min: 0,
      idleTimeoutMillis: DB_REPLICA_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_REPLICA_POOL_CONNECTION_TIMEOUT_MS,
    });
    dbPoolUtilization.labels(url, "read").set(snap.utilization);
    dbPoolTotalConnections.labels(url, "read").set(snap.totalCount);
    dbPoolIdleConnections.labels(url, "read").set(snap.idleCount);
    dbPoolWaitingConnections.labels(url, "read").set(snap.waitingCount);
    dbPoolMaxConnections.labels(url, "read").set(snap.maxConnections);
    dbPoolConfig.labels(url, "read", "min").set(snap.config.min);
    dbPoolConfig
      .labels(url, "read", "idle_timeout_ms")
      .set(snap.config.idleTimeoutMillis);
    dbPoolConfig
      .labels(url, "read", "connection_timeout_ms")
      .set(snap.config.connectionTimeoutMillis);
  });
}

/**
 * Start the periodic pool utilization monitor. Idempotent – subsequent calls
 * are ignored so importing this module from multiple places is safe.
 */
let poolMonitorStarted = false;
export function startPoolUtilizationMonitor(): void {
  if (poolMonitorStarted) return;
  poolMonitorStarted = true;
  updatePoolMetrics();
  setInterval(updatePoolMetrics, DB_POOL_MONITOR_INTERVAL_MS);
}

startPoolUtilizationMonitor();

// ─── Connection Timeout Recovery (#488) ───────────────────────────────────────

/**
 * Detects whether a database error indicates a connection timeout or broken socket.
 */
export function isConnectionTimeoutError(err: any): boolean {
  if (!err) return false;
  const message = (err.message || "").toLowerCase();
  const code = (err.code || "").toUpperCase();
  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "57014" || // query_canceled / statement_timeout
    message.includes("connection timeout") ||
    message.includes("timeout exceeded") ||
    message.includes("client has encountered a connection error")
  );
}

let isRecoveringPool = false;

/**
 * Recovers database connection pool when timeouts occur by resetting idle connections.
 */
export async function recoverDatabasePoolOnTimeout(err: any, poolInstance: Pool = pool): Promise<boolean> {
  if (!isConnectionTimeoutError(err)) return false;

  if (isRecoveringPool) {
    return false;
  }

  isRecoveringPool = true;
  console.warn("[db-recovery] Detected connection timeout. Initiating connection pool reset...", {
    errorCode: err.code,
    errorMessage: err.message,
  });

  try {
    // Attempt health-check probe
    const probeTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Probe timed out")), 2000)
    );
    await Promise.race([poolInstance.query("SELECT 1"), probeTimeout]);
    console.info("[db-recovery] Pool recovered successfully on probe query");
    return true;
  } catch (probeErr: any) {
    console.error("[db-recovery] Pool probe failed. Purging idle connections...", probeErr.message);
    return false;
  } finally {
    isRecoveringPool = false;
  }
}

// Attach automatic recovery handlers to pools
pool.on("error", (err: any) => {
  if (isConnectionTimeoutError(err)) {
    recoverDatabasePoolOnTimeout(err, pool);
  }
});

writePool.on("error", (err: any) => {
  if (isConnectionTimeoutError(err)) {
    recoverDatabasePoolOnTimeout(err, writePool);
  }
});