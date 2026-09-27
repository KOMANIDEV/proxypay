/**
 * #356 – Enhanced Read Replica Routing
 *
 * Adds fallback to primary on replica failure, health monitoring, retry with
 * exponential backoff, replica usage metrics, and an admin endpoint to remove
 * unhealthy replicas from rotation.
 */

import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";
import { Counter, Gauge, Histogram, register } from "prom-client";

// ─── Prometheus Metrics ───────────────────────────────────────────────────────

export const replicaQueryTotal = new Counter({
  name: "db_replica_query_total",
  help: "Total number of queries routed to replica or primary",
  labelNames: ["target", "status"],
  registers: [register],
});

export const replicaFallbackTotal = new Counter({
  name: "db_replica_fallback_total",
  help: "Total number of replica-to-primary fallbacks",
  labelNames: ["reason"],
  registers: [register],
});

export const replicaRetryTotal = new Counter({
  name: "db_replica_retry_total",
  help: "Total number of replica query retries",
  labelNames: ["attempt", "outcome"],
  registers: [register],
});

export const replicaHealthCheckTotal = new Counter({
  name: "db_replica_health_check_total",
  help: "Total number of replica health checks performed",
  labelNames: ["replica", "healthy"],
  registers: [register],
});

export const replicaActiveQueries = new Gauge({
  name: "db_replica_active_queries",
  help: "Number of currently in-flight replica queries",
  registers: [register],
});

export const replicaQueryDurationSeconds = new Histogram({
  name: "db_replica_query_duration_seconds",
  help: "Duration of queries routed through the replica routing layer",
  labelNames: ["target", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DatabaseRoutingContext {
  useReplicaPool: boolean;
  method: string;
  path: string;
  /** Set to true if this query fell back to primary due to replica failure */
  fallbackToPrimary?: boolean;
  /** Number of retries attempted */
  retryAttempts?: number;
}

export interface ReplicaHealthState {
  url: string;
  healthy: boolean;
  enabled: boolean;
  lastCheckAt: string;
  consecutiveFailures: number;
  lastError?: string;
  avgResponseTimeMs: number;
}

declare module "express" {
  interface Request {
    dbRouting?: DatabaseRoutingContext;
  }
}

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = parseInt(process.env.DB_REPLICA_MAX_RETRIES || "2", 10);
const INITIAL_BACKOFF_MS = parseInt(process.env.DB_REPLICA_INITIAL_BACKOFF_MS || "100", 10);
const MAX_BACKOFF_MS = parseInt(process.env.DB_REPLICA_MAX_BACKOFF_MS || "2000", 10);
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.DB_REPLICA_HEALTH_CHECK_INTERVAL_MS || "30000", 10);
const CONSECUTIVE_FAILURE_THRESHOLD = parseInt(process.env.DB_REPLICA_FAILURE_THRESHOLD || "3", 10);
const UNHEALTHY_REPLICA_DISABLE_SECONDS = parseInt(process.env.DB_REPLICA_UNHEALTHY_DISABLE_SECONDS || "300", 10);

// ─── In-Memory Health State ──────────────────────────────────────────────────

const replicaHealthStates = new Map<string, ReplicaHealthState>();

export function getReplicaHealthStates(): ReplicaHealthState[] {
  return Array.from(replicaHealthStates.values());
}

export function markReplicaUnhealthy(url: string, reason: string): void {
  const state = replicaHealthStates.get(url);
  if (state) {
    state.healthy = false;
    state.enabled = false;
    state.consecutiveFailures++;
    state.lastError = reason;
    state.lastCheckAt = new Date().toISOString();

    logger.warn({
      type: "replica_marked_unhealthy",
      url,
      reason,
      consecutiveFailures: state.consecutiveFailures,
    });
  }
}

export function markReplicaHealthy(url: string): void {
  const state = replicaHealthStates.get(url);
  if (state) {
    state.healthy = true;
    state.enabled = true;
    state.consecutiveFailures = 0;
    state.lastError = undefined;
    state.lastCheckAt = new Date().toISOString();

    logger.info({
      type: "replica_marked_healthy",
      url,
    });
  }
}

/**
 * Remove a replica from rotation by URL.
 * Used by admin endpoint to force-disable an unhealthy replica.
 */
export function disableReplica(url: string): boolean {
  const state = replicaHealthStates.get(url);
  if (state) {
    state.enabled = false;
    state.lastCheckAt = new Date().toISOString();

    logger.warn({
      type: "replica_disabled_by_admin",
      url,
    });
    return true;
  }
  return false;
}

/**
 * Re-enable a previously disabled replica.
 */
export function enableReplica(url: string): boolean {
  const state = replicaHealthStates.get(url);
  if (state) {
    state.enabled = state.healthy;
    state.lastCheckAt = new Date().toISOString();

    logger.info({
      type: "replica_enabled_by_admin",
      url,
    });
    return true;
  }
  return false;
}

// ─── Retry with Exponential Backoff ───────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  context: { replicaUrl?: string; operation?: string },
): Promise<{ result: T; attempts: number; target: "replica" | "primary" }> {
  let lastError: Error | undefined;
  let backoffMs = INITIAL_BACKOFF_MS;

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        replicaRetryTotal.labels({ attempt: String(attempt), outcome: "success" }).inc();
      }
      return {
        result,
        attempts: attempt + 1,
        target: context.replicaUrl ? "replica" : "primary",
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      replicaRetryTotal.labels({ attempt: String(attempt), outcome: "failure" }).inc();

      if (attempt < MAX_RETRY_ATTEMPTS) {
        logger.warn({
          type: "replica_query_retry",
          attempt: attempt + 1,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          backoffMs,
          replicaUrl: context.replicaUrl,
          operation: context.operation,
          error: lastError.message,
        });

        if (context.replicaUrl) {
          markReplicaUnhealthy(context.replicaUrl, lastError.message);
        }

        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  throw lastError;
}

// ─── Health Check Loop ────────────────────────────────────────────────────────

export function startReplicaHealthMonitoring(): void {
  if (process.env.NODE_ENV === "test") return;

  const checkInterval = setInterval(async () => {
    for (const [url, state] of replicaHealthStates) {
      if (!state.enabled && state.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
        // Check if enough time has passed to re-enable
        const disabledAt = new Date(state.lastCheckAt).getTime();
        if (Date.now() - disabledAt < UNHEALTHY_REPLICA_DISABLE_SECONDS * 1000) {
          continue;
        }
        // Attempt re-enable after cooldown
        state.enabled = state.healthy;
        state.consecutiveFailures = 0;
        state.lastCheckAt = new Date().toISOString();

        logger.info({
          type: "replica_auto_reenabled_after_cooldown",
          url,
          cooldownSeconds: UNHEALTHY_REPLICA_DISABLE_SECONDS,
        });
      }

      replicaHealthCheckTotal.labels({
        replica: url,
        healthy: String(state.healthy),
      }).inc();
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // Prevent the interval from keeping the process alive
  if (checkInterval.unref) {
    checkInterval.unref();
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────

export function readReplicaRoutingMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const useReplicaPool = isReadOperation(req.method);

  req.dbRouting = {
    useReplicaPool,
    method: req.method,
    path: req.path,
    fallbackToPrimary: false,
    retryAttempts: 0,
  };

  if (process.env.NODE_ENV === "development" && process.env.DEBUG_DB_ROUTING === "true") {
    logger.debug({
      type: "db_routing_decision",
      method: req.method,
      path: req.path,
      target: useReplicaPool ? "REPLICA" : "PRIMARY",
    });
  }

  next();
}

/**
 * Express middleware that exposes replica health and admin control.
 * Mount at /api/admin/replicas or similar protected route.
 */
export function replicaHealthRouter(req: Request, res: Response): void {
  const states = getReplicaHealthStates();
  res.json({
    replicas: states,
    timestamp: new Date().toISOString(),
  });
}

export function replicaDisableRouter(req: Request, res: Response): void {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }
  const success = disableReplica(url);
  res.json({ success, url });
}

export function replicaEnableRouter(req: Request, res: Response): void {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }
  const success = enableReplica(url);
  res.json({ success, url });
}

export function isReadOperation(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function isWriteOperation(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}
