/**
 * #358 – Provider Health Check Aggregation Service
 *
 * Aggregates per-provider health statuses into an overall system health score
 * using weighted scoring, provides caching, and exposes Prometheus metrics.
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";
import { Gauge, Counter, Histogram, register } from "prom-client";
import {
  ProviderName,
  HealthStatus,
  getProviderHealthDashboard,
  ProviderRealTimeMetrics,
} from "./providerHealthDashboardService";

// ─── Prometheus Metrics ───────────────────────────────────────────────────────

export const systemHealthScore = new Gauge({
  name: "system_health_score",
  help: "Overall system health score (0-100)",
  registers: [register],
});

export const systemHealthStatus = new Gauge({
  name: "system_health_status",
  help: "System health status (1=healthy, 0.5=degraded, 0=down)",
  labelNames: ["status"],
  registers: [register],
});

export const providerHealthScoreGauge = new Gauge({
  name: "provider_health_score",
  help: "Per-provider weighted health score (0-100)",
  labelNames: ["provider"],
  registers: [register],
});

export const providerHealthCheckAggregationTotal = new Counter({
  name: "provider_health_check_aggregation_total",
  help: "Total number of provider health aggregation cycles",
  labelNames: ["status"],
  registers: [register],
});

export const providerHealthAggregationDurationSeconds = new Histogram({
  name: "provider_health_aggregation_duration_seconds",
  help: "Duration of provider health aggregation in seconds",
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const providerAvailabilityGauge = new Gauge({
  name: "provider_availability_percent",
  help: "Provider availability percentage",
  labelNames: ["provider"],
  registers: [register],
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SystemHealthAggregation {
  overallScore: number;          // 0–100
  overallStatus: HealthStatus;
  providers: ProviderWeightedScore[];
  generatedAt: string;
  cached: boolean;
}

export interface ProviderWeightedScore {
  provider: ProviderName;
  score: number;                 // 0–100
  weight: number;                // 0–1, sum of all = 1
  status: HealthStatus;
  availabilityPct: number | null;
  avgResponseTimeMs: number | null;
}

// ─── Provider Weights ─────────────────────────────────────────────────────────
// Weights reflect each provider's share of total transaction volume.
// Configurable via PROVIDER_WEIGHTS env var (JSON object).

function getProviderWeights(): Record<ProviderName, number> {
  const defaults: Record<ProviderName, number> = {
    mtn: 0.45,
    airtel: 0.35,
    orange: 0.20,
  };

  try {
    const envWeights = process.env.PROVIDER_WEIGHTS;
    if (envWeights) {
      const parsed = JSON.parse(envWeights) as Partial<Record<ProviderName, number>>;
      const merged = { ...defaults, ...parsed };
      const total = Object.values(merged).reduce((a, b) => a + b, 0);
      if (total > 0) {
        const normalized: Record<ProviderName, number> = {
          mtn: merged.mtn / total,
          airtel: merged.airtel / total,
          orange: merged.orange / total,
        };
        return normalized;
      }
    }
  } catch {
    // Fall back to defaults on parse error
  }

  return defaults;
}

// ─── Scoring Functions ────────────────────────────────────────────────────────

function scoreProvider(provider: ProviderRealTimeMetrics): number {
  let score = 0;

  // Availability contributes 60% of the score
  if (provider.availabilityPct !== null) {
    score += (provider.availabilityPct / 100) * 60;
  } else {
    // Unknown providers get a neutral 50% of availability weight
    score += 0.5 * 60;
  }

  // Response time contributes 30% of the score (inversely proportional)
  if (provider.avgResponseTimeMs !== null) {
    // Perfect score at 0ms, zero score at 30s+
    const rtScore = Math.max(0, 1 - provider.avgResponseTimeMs / 30_000);
    score += rtScore * 30;
  } else {
    score += 0.5 * 30;
  }

  // Call volume contributes 10% (having traffic is a sign of health)
  if (provider.totalCallsLastHour > 0) {
    score += 10;
  } else {
    score += 3; // Minimal score for unknown/unused providers
  }

  return Math.round(score * 100) / 100;
}

function scoreToStatus(score: number): HealthStatus {
  if (score >= 80) return "healthy";
  if (score >= 50) return "degraded";
  if (score >= 20) return "down";
  return "unknown";
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const AGGREGATION_CACHE_KEY = "provider_health:system_aggregation";
const AGGREGATION_CACHE_TTL = 30; // seconds

async function cachedAggregationGet(): Promise<SystemHealthAggregation | null> {
  try {
    const raw = await redisClient.get(AGGREGATION_CACHE_KEY);
    return raw ? (JSON.parse(raw) as SystemHealthAggregation) : null;
  } catch {
    return null;
  }
}

async function cachedAggregationSet(data: SystemHealthAggregation): Promise<void> {
  try {
    await redisClient.setEx(AGGREGATION_CACHE_KEY, AGGREGATION_CACHE_TTL, JSON.stringify(data));
  } catch {
    // swallow – cache failure must not block health checks
  }
}

// ─── Core Aggregation ────────────────────────────────────────────────────────

export async function getSystemHealthAggregation(
  forceRefresh = false,
): Promise<SystemHealthAggregation> {
  const timer = providerHealthAggregationDurationSeconds.startTimer();

  try {
    if (!forceRefresh) {
      const cached = await cachedAggregationGet();
      if (cached) {
        timer();
        return cached;
      }
    }

    const dashboard = await getProviderHealthDashboard(forceRefresh);
    const weights = getProviderWeights();
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

    const providerScores: ProviderWeightedScore[] = dashboard.providers.map((p) => {
      const score = scoreProvider(p);
      const normalizedWeight = weights[p.provider] / totalWeight;

      return {
        provider: p.provider,
        score,
        weight: Math.round(normalizedWeight * 100) / 100,
        status: scoreToStatus(score),
        availabilityPct: p.availabilityPct,
        avgResponseTimeMs: p.avgResponseTimeMs,
      };
    });

    // Weighted overall score
    const overallScore = Math.round(
      providerScores.reduce((sum, p) => sum + p.score * p.weight, 0) * 100,
    ) / 100;
    const overallStatus = scoreToStatus(overallScore);

    const aggregation: SystemHealthAggregation = {
      overallScore,
      overallStatus,
      providers: providerScores,
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    // Update Prometheus metrics
    systemHealthScore.set(overallScore);
    systemHealthStatus.reset();
    systemHealthStatus.labels(overallStatus).set(1);

    for (const ps of providerScores) {
      providerHealthScoreGauge.labels(ps.provider).set(ps.score);
      if (ps.availabilityPct !== null) {
        providerAvailabilityGauge.labels(ps.provider).set(ps.availabilityPct);
      }
    }

    providerHealthCheckAggregationTotal.inc({ status: overallStatus });

    await cachedAggregationSet(aggregation);
    return aggregation;
  } finally {
    timer();
  }
}

// ─── Persistence for historical tracking ─────────────────────────────────────

export async function recordSystemHealthSnapshot(): Promise<void> {
  try {
    const aggregation = await getSystemHealthAggregation(true);

    await pool.query(
      `INSERT INTO system_health_snapshots (snapshot_hour, overall_score, overall_status, provider_scores, created_at)
       VALUES (date_trunc('hour', NOW()), $1, $2, $3, NOW())
       ON CONFLICT (snapshot_hour) DO UPDATE
         SET overall_score = EXCLUDED.overall_score,
             overall_status = EXCLUDED.overall_status,
             provider_scores = EXCLUDED.provider_scores`,
      [
        aggregation.overallScore,
        aggregation.overallStatus,
        JSON.stringify(aggregation.providers),
      ],
    );

    logger.info({
      type: "system_health_snapshot_recorded",
      overallScore: aggregation.overallScore,
      overallStatus: aggregation.overallStatus,
    });
  } catch (err) {
    logger.error({
      type: "system_health_snapshot_record_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
