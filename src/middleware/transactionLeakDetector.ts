/**
 * #355 – Extended Connection Leak Detector for Transaction Queries
 *
 * Extends the base connection leak detector to track transaction-specific
 * queries (BEGIN/COMMIT/ROLLBACK), warn on long-running transactions,
 * expose connection pool statistics, and provide a monitoring dashboard endpoint.
 */

import { Request, Response, NextFunction } from "express";
import { PoolClient } from "pg";
import logger from "../utils/logger";
import { Counter, Gauge, Histogram, register } from "prom-client";

// ─── Prometheus Metrics ───────────────────────────────────────────────────────

export const transactionQueryDurationSeconds = new Histogram({
  name: "transaction_query_duration_seconds",
  help: "Duration of transaction-specific queries (BEGIN, COMMIT, ROLLBACK)",
  labelNames: ["operation", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const longRunningTransactions = new Gauge({
  name: "db_long_running_transactions",
  help: "Number of currently long-running database transactions",
  registers: [register],
});

export const transactionQueryWarningsTotal = new Counter({
  name: "transaction_query_warnings_total",
  help: "Total number of warnings for long-running transaction queries",
  labelNames: ["type"],
  registers: [register],
});

export const transactionConnectionCheckouts = new Counter({
  name: "transaction_connection_checkouts_total",
  help: "Total number of connection checkouts for transaction queries",
  labelNames: ["operation"],
  registers: [register],
});

export const transactionActiveConnections = new Gauge({
  name: "transaction_active_connections",
  help: "Number of connections currently checked out for transaction operations",
  registers: [register],
});

// ─── Configuration ────────────────────────────────────────────────────────────

const TRANSACTION_WARNING_THRESHOLD_MS = parseInt(
  process.env.DB_TRANSACTION_WARNING_THRESHOLD_MS || "10000",
  10,
);

const TRANSACTION_CRITICAL_THRESHOLD_MS = parseInt(
  process.env.DB_TRANSACTION_CRITICAL_THRESHOLD_MS || "60000",
  10,
);

const TRANSACTION_QUERY_LOG_THRESHOLD_MS = parseInt(
  process.env.DB_TRANSACTION_QUERY_LOG_THRESHOLD_MS || "5000",
  10,
);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransactionTrackedConnection {
  client: PoolClient;
  checkedOutAt: number;
  checkoutStack: string;
  endpoint: string;
  method: string;
  requestId?: string;
  operation: "BEGIN" | "COMMIT" | "ROLLBACK" | "QUERY" | "UNKNOWN";
  warningEmitted: boolean;
}

export interface ConnectionPoolStats {
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
  activeTransactions: number;
  longRunningTransactions: number;
  avgCheckoutDurationMs: number;
  leakedConnections: number;
  timestamp: string;
}

// ─── Tracking State ───────────────────────────────────────────────────────────

const transactionTrackers = new Map<number, TransactionTrackedConnection>();

function classifyOperation(query: string): TransactionTrackedConnection["operation"] {
  const upper = query.trim().toUpperCase();
  if (upper === "BEGIN" || upper.startsWith("BEGIN ")) return "BEGIN";
  if (upper === "COMMIT") return "COMMIT";
  if (upper === "ROLLBACK" || upper.startsWith("ROLLBACK ")) return "ROLLBACK";
  return "QUERY";
}

function extractEndpoint(stack: string): string {
  const match = stack.match(/at\s+.*?\s+\((.+):\d+:\d+\)/);
  if (match) {
    const filePath = match[1];
    const fileName = filePath.split("/").pop() || filePath;
    return fileName;
  }
  return "unknown";
}

// ─── Connection Tracking ──────────────────────────────────────────────────────

/**
 * Track a connection checkout for a transaction query.
 * Wraps the client's query method to monitor transaction operations.
 */
export function trackTransactionConnection(
  client: PoolClient,
  options?: {
    endpoint?: string;
    method?: string;
    requestId?: string;
  },
): void {
  const error = new Error("Transaction connection tracker");
  const stack =
    error.stack?.split("\n").slice(3).join("\n") || "Stack trace unavailable";

  const tracked: TransactionTrackedConnection = {
    client,
    checkedOutAt: Date.now(),
    checkoutStack: stack,
    endpoint: options?.endpoint || extractEndpoint(stack),
    method: options?.method || "UNKNOWN",
    requestId: options?.requestId,
    operation: "UNKNOWN",
    warningEmitted: false,
  };

  const connectionId = (client as any).processID;
  transactionTrackers.set(connectionId, tracked);
  transactionActiveConnections.inc();

  // Wrap client.query to intercept transaction operations
  const originalQuery = client.query.bind(client);
  (client as any).query = function (
    ...args: any[]
  ): any {
    const sql = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
    const operation = classifyOperation(sql);

    tracked.operation = operation;
    transactionConnectionCheckouts.labels({ operation }).inc();

    const startTime = process.hrtime.bigint();

    const result = originalQuery(...args);

    // Handle both sync and async results
    if (result && typeof result.then === "function") {
      return result.then(
        (res: any) => {
          recordTransactionQueryDuration(startTime, operation, "success");
          return res;
        },
        (err: any) => {
          recordTransactionQueryDuration(startTime, operation, "error");
          throw err;
        },
      );
    }

    return result;
  };

  // Wrap client.release to clean up tracking
  const originalRelease = client.release.bind(client);
  (client as any).release = function (...releaseArgs: any[]): void {
    const heldForMs = Date.now() - tracked.checkedOutAt;

    transactionTrackers.delete(connectionId);
    transactionActiveConnections.dec();

    if (heldForMs > TRANSACTION_WARNING_THRESHOLD_MS) {
      if (!tracked.warningEmitted) {
        tracked.warningEmitted = true;
        transactionQueryWarningsTotal.labels({ type: "long_checkout" }).inc();

        logger.warn({
          type: "transaction_connection_long_checkout",
          connectionId,
          durationMs: heldForMs,
          thresholdMs: TRANSACTION_WARNING_THRESHOLD_MS,
          endpoint: tracked.endpoint,
          method: tracked.method,
          operation: tracked.operation,
          requestId: tracked.requestId,
          message: "Transaction connection held for extended period",
        });
      }
    }

    if (heldForMs > TRANSACTION_CRITICAL_THRESHOLD_MS) {
      transactionQueryWarningsTotal.labels({ type: "critical_checkout" }).inc();

      logger.error({
        type: "transaction_connection_critical_checkout",
        connectionId,
        durationMs: heldForMs,
        thresholdMs: TRANSACTION_CRITICAL_THRESHOLD_MS,
        endpoint: tracked.endpoint,
        method: tracked.method,
        operation: tracked.operation,
        checkoutStack: tracked.checkoutStack,
        requestId: tracked.requestId,
        message: "CRITICAL: Transaction connection held for dangerously long period",
      });
    }

    return originalRelease.apply(this, releaseArgs);
  };
}

function recordTransactionQueryDuration(
  startTime: bigint,
  operation: string,
  status: string,
): void {
  const endTime = process.hrtime.bigint();
  const durationMs = Number(endTime - startTime) / 1e6;

  transactionQueryDurationSeconds.labels({ operation, status }).observe(durationMs / 1000);

  if (durationMs > TRANSACTION_QUERY_LOG_THRESHOLD_MS) {
    logger.warn({
      type: "slow_transaction_query",
      operation,
      durationMs: Math.round(durationMs),
      thresholdMs: TRANSACTION_QUERY_LOG_THRESHOLD_MS,
      message: `Slow transaction ${operation} query detected`,
    });
  }
}

// ─── Long-Running Transaction Monitor ────────────────────────────────────────

/**
 * Scan currently tracked connections for long-running transactions.
 * Returns the count of long-running transactions.
 */
export function scanForLongRunningTransactions(): TransactionTrackedConnection[] {
  const now = Date.now();
  const longRunning: TransactionTrackedConnection[] = [];

  for (const [, tracked] of transactionTrackers) {
    const heldForMs = now - tracked.checkedOutAt;
    if (heldForMs > TRANSACTION_WARNING_THRESHOLD_MS) {
      longRunning.push(tracked);
    }
  }

  longRunningTransactions.set(longRunning.length);
  return longRunning;
}

/**
 * Start periodic scanning for long-running transactions.
 */
export function startLongRunningTransactionMonitor(
  intervalMs: number = 15000,
): ReturnType<typeof setInterval> | null {
  if (process.env.NODE_ENV === "test") return null;

  const interval = setInterval(() => {
    const longRunning = scanForLongRunningTransactions();
    if (longRunning.length > 0) {
      for (const tracked of longRunning) {
        const heldForMs = Date.now() - tracked.checkedOutAt;
        if (heldForMs > TRANSACTION_CRITICAL_THRESHOLD_MS && !tracked.warningEmitted) {
          transactionQueryWarningsTotal.labels({ type: "periodic_critical" }).inc();

          logger.error({
            type: "long_running_transaction_detected",
            connectionId: (tracked.client as any).processID,
            durationMs: heldForMs,
            endpoint: tracked.endpoint,
            method: tracked.method,
            operation: tracked.operation,
            checkoutStack: tracked.checkoutStack,
            requestId: tracked.requestId,
            message: "Long-running transaction detected by periodic monitor",
          });
        }
      }
    }
  }, intervalMs);

  if (interval.unref) {
    interval.unref();
  }

  return interval;
}

// ─── Connection Pool Statistics ───────────────────────────────────────────────

/**
 * Get comprehensive connection pool statistics.
 */
export function getConnectionPoolStats(
  primaryPool: any,
  replicaPools: any[] = [],
): ConnectionPoolStats {
  const primaryStats = primaryPool || {};
  const activeTransactionsCount = transactionTrackers.size;
  const longRunningCount = scanForLongRunningTransactions().length;

  // Calculate average checkout duration from active trackers
  let totalCheckoutDurationMs = 0;
  const now = Date.now();
  for (const [, tracked] of transactionTrackers) {
    totalCheckoutDurationMs += now - tracked.checkedOutAt;
  }
  const avgCheckoutDurationMs =
    activeTransactionsCount > 0
      ? Math.round(totalCheckoutDurationMs / activeTransactionsCount)
      : 0;

  return {
    totalConnections: (primaryStats.totalCount ?? primaryStats._pool?.totalCount) || 0,
    idleConnections: (primaryStats.idleCount ?? primaryStats._pool?.idleCount) || 0,
    waitingClients: (primaryStats.waitingCount ?? primaryStats._pool?.waitingCount) || 0,
    activeTransactions: activeTransactionsCount,
    longRunningTransactions: longRunningCount,
    avgCheckoutDurationMs,
    leakedConnections: 0, // Would integrate with existing leak detector
    timestamp: new Date().toISOString(),
  };
}

// ─── Express Middleware ───────────────────────────────────────────────────────

/**
 * Middleware that tracks transaction connections for the request lifecycle.
 */
export function transactionLeakDetector(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const endpoint = `${req.method} ${req.route?.path || req.path}`;
  const requestId = req.headers["x-request-id"] as string | undefined;

  const checkInterval = setInterval(() => {
    scanForLongRunningTransactions();
  }, 5000);

  req.on("close", () => {
    clearInterval(checkInterval);

    // Check for any connections still tracked for this endpoint
    for (const [, tracked] of transactionTrackers) {
      if (tracked.endpoint === endpoint && tracked.method === req.method) {
        transactionQueryWarningsTotal.labels({ type: "unreturned_after_request" }).inc();

        logger.error({
          type: "transaction_connection_unreturned",
          endpoint,
          method: req.method,
          heldForMs: Date.now() - tracked.checkedOutAt,
          checkoutStack: tracked.checkoutStack,
          requestId,
          message: "Transaction connection still checked out after request completed",
        });
      }
    }
  });

  next();
}

// ─── Admin Dashboard Endpoint ─────────────────────────────────────────────────

/**
 * Express handler that returns a JSON dashboard of connection pool state.
 * Mount at a protected admin route (e.g., /api/admin/connections).
 */
export function connectionDashboardHandler(
  req: Request,
  res: Response,
): void {
  const trackedConnections = Array.from(transactionTrackers.entries()).map(
    ([id, tracked]) => ({
      connectionId: id,
      endpoint: tracked.endpoint,
      method: tracked.method,
      operation: tracked.operation,
      heldForMs: Date.now() - tracked.checkedOutAt,
      requestId: tracked.requestId,
    }),
  );

  const longRunning = scanForLongRunningTransactions().map((t) => ({
    endpoint: t.endpoint,
    operation: t.operation,
    heldForMs: Date.now() - t.checkedOutAt,
  }));

  res.json({
    activeTrackers: transactionTrackers.size,
    longRunningTransactions: longRunning,
    trackedConnections,
    timestamp: new Date().toISOString(),
  });
}

// ─── Utility Exports ──────────────────────────────────────────────────────────

export function getTrackedTransactionConnections(): Map<number, TransactionTrackedConnection> {
  return transactionTrackers;
}

export function getTrackedTransactionCount(): number {
  return transactionTrackers.size;
}

export function forceReleaseAllTransactionConnections(): number {
  let released = 0;
  for (const [, tracked] of transactionTrackers) {
    try {
      tracked.client?.release();
      released++;
    } catch (err) {
      logger.error({
        type: "transaction_connection_force_release_failed",
        error: String(err),
        message: "Failed to force-release transaction connection during cleanup",
      });
    }
  }
  transactionTrackers.clear();
  transactionActiveConnections.set(0);
  return released;
}
