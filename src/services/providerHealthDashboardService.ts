/**
 * #405 – Provider Health Dashboard Service
 *
 * Provides:
 *  - Real-time provider status (response time, availability %, status colour)
 *  - Historical performance trends (hourly snapshots, last 24h / 7d)
 *  - Alert detection (availability below threshold)
 *  - Snapshot recorder (called by scheduler job)
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import { Gauge } from "prom-client";
import { register } from "../utils/metrics";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProviderName = "mtn" | "airtel" | "orange";
export type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

export interface ProviderRealTimeMetrics {
  provider: ProviderName;
  status: HealthStatus;
  availabilityPct: number | null;   // 0–100
  avgResponseTimeMs: number | null;
  p95ResponseTimeMs: number | null;
  totalCallsLastHour: number;
  lastCalledAt: string | null;
  alerts: ProviderAlert[];
}

export interface ProviderAlert {
  severity: "warning" | "critical";
  message: string;
  detectedAt: string;
}

export interface ProviderTrendPoint {
  hour: string;            // ISO timestamp, truncated to hour
  availabilityPct: number | null;
  avgResponseTimeMs: number | null;
  p95ResponseTimeMs: number | null;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
}

export interface ProviderHealthDashboard {
  generatedAt: string;
  providers: ProviderRealTimeMetrics[];
  systemHealth: SystemHealth;
}

export interface SystemHealth {
  status: HealthStatus;
  score: number;
  criticalProvidersDown: string[];
}

export interface ProviderHistoricalTrends {
  provider: ProviderName;
  period: "24h" | "7d";
  points: ProviderTrendPoint[];
  generatedAt: string;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const AVAILABILITY_CRITICAL = 80;   // < 80 % → critical
const AVAILABILITY_WARNING = 95;    // < 95 % → warning
const RESPONSE_TIME_WARNING_MS = 5_000;
const RESPONSE_TIME_CRITICAL_MS = 15_000;

/**
 * Provider weights for system-wide health scoring.
 * Higher weight = more critical to overall system availability.
 */
const PROVIDER_WEIGHTS: Record<ProviderName, number> = {
  mtn: 5,
  airtel: 3,
  orange: 2,
};

const systemHealthGauge = new Gauge({
  name: "provider_system_health_score",
  help: "Weighted system health score (0-100)",
  registers: [register],
});

function toHealthStatus(availabilityPct: number | null): HealthStatus {
  if (availabilityPct === null) return "unknown";
  if (availabilityPct < AVAILABILITY_CRITICAL) return "down";
  if (availabilityPct < AVAILABILITY_WARNING) return "degraded";
  return "healthy";
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const DASHBOARD_CACHE_KEY = "provider_health:dashboard";
const DASHBOARD_CACHE_TTL = 30; // seconds

async function cachedDashboardGet(): Promise<ProviderHealthDashboard | null> {
  try {
    const raw = await redisClient.get(DASHBOARD_CACHE_KEY);
    return raw ? (JSON.parse(raw) as ProviderHealthDashboard) : null;
  } catch {
    return null;
  }
}

async function cachedDashboardSet(dashboard: ProviderHealthDashboard): Promise<void> {
  try {
    await redisClient.setEx(DASHBOARD_CACHE_KEY, DASHBOARD_CACHE_TTL, JSON.stringify(dashboard));
  } catch {
    // swallow
  }
}

// ─── Real-time dashboard ──────────────────────────────────────────────────────

/**
 * Return the real-time health dashboard.
 * Refreshed from the materialized view every 30 seconds (Redis cache).
 */
export async function getProviderHealthDashboard(
  forceRefresh = false,
): Promise<ProviderHealthDashboard> {
  if (!forceRefresh) {
    const cached = await cachedDashboardGet();
    if (cached) return cached;
  }

  const PROVIDERS: ProviderName[] = ["mtn", "airtel", "orange"];

  // Try materialized view first; fall back to live query if it doesn't exist yet
  let rows: Array<{
    provider: ProviderName;
    total_calls: string;
    success_calls: string;
    avg_duration_ms: string | null;
    p95_duration_ms: string | null;
    availability_pct: string | null;
    last_called_at: Date | null;
  }>;

  try {
    const result = await pool.query<(typeof rows)[number]>(
      `SELECT provider,
              total_calls,
              success_calls,
              avg_duration_ms,
              p95_duration_ms,
              availability_pct,
              last_called_at
       FROM mv_provider_current_health`,
    );
    rows = result.rows;
  } catch {
    // Materialized view not yet created – use live query
    const result = await pool.query<(typeof rows)[number]>(`
      SELECT
        provider,
        COUNT(*)                                       AS total_calls,
        COUNT(*) FILTER (WHERE success)                AS success_calls,
        ROUND(AVG(duration_ms)::numeric, 2)            AS avg_duration_ms,
        ROUND(
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2
        )                                              AS p95_duration_ms,
        ROUND(
          (COUNT(*) FILTER (WHERE success))::numeric / NULLIF(COUNT(*), 0) * 100, 2
        )                                              AS availability_pct,
        MAX(called_at)                                 AS last_called_at
      FROM provider_api_calls
      WHERE called_at >= NOW() - INTERVAL '1 hour'
      GROUP BY provider
    `);
    rows = result.rows;
  }

  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const generatedAt = new Date().toISOString();

  const providers: ProviderRealTimeMetrics[] = PROVIDERS.map((name) => {
    const row = byProvider.get(name);

    if (!row || Number(row.total_calls) === 0) {
      return {
        provider: name,
        status: "unknown" as HealthStatus,
        availabilityPct: null,
        avgResponseTimeMs: null,
        p95ResponseTimeMs: null,
        totalCallsLastHour: 0,
        lastCalledAt: null,
        alerts: [],
      };
    }

    const availabilityPct = row.availability_pct != null ? Number(row.availability_pct) : null;
    const avgResponseTimeMs = row.avg_duration_ms != null ? Math.round(Number(row.avg_duration_ms)) : null;
    const p95ResponseTimeMs = row.p95_duration_ms != null ? Math.round(Number(row.p95_duration_ms)) : null;

    const alerts = buildAlerts(name, availabilityPct, avgResponseTimeMs, p95ResponseTimeMs);

    return {
      provider: name,
      status: toHealthStatus(availabilityPct),
      availabilityPct,
      avgResponseTimeMs,
      p95ResponseTimeMs,
      totalCallsLastHour: Number(row.total_calls),
      lastCalledAt: row.last_called_at ? new Date(row.last_called_at).toISOString() : null,
      alerts,
    };
  });

  const dashboard: ProviderHealthDashboard = { generatedAt, providers, systemHealth: computeSystemHealth(providers) };
  systemHealthGauge.set(dashboard.systemHealth.score);
  await cachedDashboardSet(dashboard);
  return dashboard;
}

function computeSystemHealth(providers: ProviderRealTimeMetrics[]): SystemHealth {
  let totalWeight = 0;
  let weightedScore = 0;
  const criticalDown: string[] = [];

  for (const p of providers) {
    const weight = PROVIDER_WEIGHTS[p.provider] ?? 1;
    totalWeight += weight;

    if (p.status === "down") {
      if (weight >= 4) criticalDown.push(p.provider);
      // score contribution = 0
    } else if (p.status === "degraded") {
      weightedScore += weight * 50;
    } else if (p.status === "healthy") {
      weightedScore += weight * 100;
    }
    // "unknown" contributes 0
  }

  const score = totalWeight > 0 ? Math.round((weightedScore / totalWeight) * 100) / 100 : 0;
  let status: HealthStatus = "healthy";
  if (criticalDown.length > 0 || score < AVAILABILITY_CRITICAL) {
    status = "down";
  } else if (score < AVAILABILITY_WARNING) {
    status = "degraded";
  }

  return { status, score, criticalProvidersDown: criticalDown };
}

function buildAlerts(
  provider: ProviderName,
  availabilityPct: number | null,
  avgResponseTimeMs: number | null,
  p95ResponseTimeMs: number | null,
): ProviderAlert[] {
  const alerts: ProviderAlert[] = [];
  const now = new Date().toISOString();

  if (availabilityPct !== null) {
    if (availabilityPct < AVAILABILITY_CRITICAL) {
      alerts.push({
        severity: "critical",
        message: `${provider.toUpperCase()} availability is critically low: ${availabilityPct.toFixed(1)}%`,
        detectedAt: now,
      });
    } else if (availabilityPct < AVAILABILITY_WARNING) {
      alerts.push({
        severity: "warning",
        message: `${provider.toUpperCase()} availability is degraded: ${availabilityPct.toFixed(1)}%`,
        detectedAt: now,
      });
    }
  }

  if (p95ResponseTimeMs !== null && p95ResponseTimeMs > RESPONSE_TIME_CRITICAL_MS) {
    alerts.push({
      severity: "critical",
      message: `${provider.toUpperCase()} P95 response time is critically high: ${p95ResponseTimeMs}ms`,
      detectedAt: now,
    });
  } else if (avgResponseTimeMs !== null && avgResponseTimeMs > RESPONSE_TIME_WARNING_MS) {
    alerts.push({
      severity: "warning",
      message: `${provider.toUpperCase()} average response time is elevated: ${avgResponseTimeMs}ms`,
      detectedAt: now,
    });
  }

  return alerts;
}

// ─── Historical trends ────────────────────────────────────────────────────────

/**
 * Return hourly trend data for a specific provider.
 * period: "24h" → last 24 data points, "7d" → last 168 data points
 */
export async function getProviderHistoricalTrends(
  provider: ProviderName,
  period: "24h" | "7d" = "24h",
): Promise<ProviderHistoricalTrends> {
  const hours = period === "7d" ? 168 : 24;

  // Try snapshot table first (pre-aggregated), fall back to live aggregation
  let points: ProviderTrendPoint[];

  try {
    const { rows } = await pool.query<{
      snapshot_hour: Date;
      total_calls: string;
      success_calls: string;
      failed_calls: string;
      avg_duration_ms: string | null;
      p95_duration_ms: string | null;
      availability_pct: string | null;
    }>(
      `SELECT snapshot_hour, total_calls, success_calls, failed_calls,
              avg_duration_ms, p95_duration_ms, availability_pct
       FROM provider_health_snapshots
       WHERE provider = $1
         AND snapshot_hour >= NOW() - ($2 || ' hours')::INTERVAL
       ORDER BY snapshot_hour`,
      [provider, hours],
    );

    points = rows.map((r) => ({
      hour: new Date(r.snapshot_hour).toISOString(),
      availabilityPct: r.availability_pct != null ? Number(r.availability_pct) : null,
      avgResponseTimeMs: r.avg_duration_ms != null ? Math.round(Number(r.avg_duration_ms)) : null,
      p95ResponseTimeMs: r.p95_duration_ms != null ? Math.round(Number(r.p95_duration_ms)) : null,
      totalCalls: Number(r.total_calls),
      successCalls: Number(r.success_calls),
      failedCalls: Number(r.failed_calls),
    }));
  } catch {
    // Snapshot table doesn't exist yet – aggregate from raw calls
    const { rows } = await pool.query<{
      snapshot_hour: Date;
      total_calls: string;
      success_calls: string;
      failed_calls: string;
      avg_duration_ms: string | null;
      p95_duration_ms: string | null;
    }>(
      `SELECT
         date_trunc('hour', called_at)                     AS snapshot_hour,
         COUNT(*)                                          AS total_calls,
         COUNT(*) FILTER (WHERE success)                   AS success_calls,
         COUNT(*) FILTER (WHERE NOT success)               AS failed_calls,
         ROUND(AVG(duration_ms)::numeric, 2)               AS avg_duration_ms,
         ROUND(
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2
         )                                                 AS p95_duration_ms
       FROM provider_api_calls
       WHERE provider = $1
         AND called_at >= NOW() - ($2 || ' hours')::INTERVAL
       GROUP BY date_trunc('hour', called_at)
       ORDER BY snapshot_hour`,
      [provider, hours],
    );

    points = rows.map((r) => {
      const total = Number(r.total_calls);
      const success = Number(r.success_calls);
      return {
        hour: new Date(r.snapshot_hour).toISOString(),
        availabilityPct: total > 0 ? Math.round((success / total) * 100 * 100) / 100 : null,
        avgResponseTimeMs: r.avg_duration_ms != null ? Math.round(Number(r.avg_duration_ms)) : null,
        p95ResponseTimeMs: r.p95_duration_ms != null ? Math.round(Number(r.p95_duration_ms)) : null,
        totalCalls: total,
        successCalls: success,
        failedCalls: Number(r.failed_calls),
      };
    });
  }

  return { provider, period, points, generatedAt: new Date().toISOString() };
}

// ─── Snapshot recorder (called by scheduler) ─────────────────────────────────

/**
 * Record an hourly health snapshot for all providers.
 * Called by the scheduler job every hour.
 */
export async function recordHourlyProviderSnapshots(): Promise<void> {
  const PROVIDERS: ProviderName[] = ["mtn", "airtel", "orange"];
  const currentHour = new Date();
  currentHour.setMinutes(0, 0, 0);

  for (const provider of PROVIDERS) {
    try {
      await pool.query(
        `INSERT INTO provider_health_snapshots
           (provider, snapshot_hour, total_calls, success_calls, failed_calls, avg_duration_ms, p95_duration_ms)
         SELECT
           $1                                             AS provider,
           date_trunc('hour', NOW()) - INTERVAL '1 hour' AS snapshot_hour,
           COUNT(*)                                       AS total_calls,
           COUNT(*) FILTER (WHERE success)               AS success_calls,
           COUNT(*) FILTER (WHERE NOT success)           AS failed_calls,
           ROUND(AVG(duration_ms)::numeric, 2)           AS avg_duration_ms,
           ROUND(
             PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2
           )                                             AS p95_duration_ms
         FROM provider_api_calls
         WHERE provider = $1
           AND called_at >= date_trunc('hour', NOW()) - INTERVAL '1 hour'
           AND called_at <  date_trunc('hour', NOW())
         ON CONFLICT (provider, snapshot_hour) DO UPDATE
           SET total_calls     = EXCLUDED.total_calls,
               success_calls   = EXCLUDED.success_calls,
               failed_calls    = EXCLUDED.failed_calls,
               avg_duration_ms = EXCLUDED.avg_duration_ms,
               p95_duration_ms = EXCLUDED.p95_duration_ms`,
        [provider],
      );
    } catch (err) {
      console.error("[provider-health] Failed to record snapshot", { provider, err });
    }
  }

  // Also refresh the materialized view if it exists
  try {
    await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_provider_current_health");
  } catch {
    // View may not be created yet or CONCURRENTLY not available — ignore
  }
}
