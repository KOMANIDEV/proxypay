/**
 * Provider Performance Optimization
 *
 * Latency-aware provider selection with success rate scoring, sticky sessions,
 * and admin-configurable weights.
 */

import { pool } from "../config/database";

export type ProviderName = "mtn" | "airtel" | "orange";

export interface ProviderScore {
  provider: ProviderName;
  score: number;
  avgLatencyMs: number;
  successRate: number;
  totalCalls: number;
  sticky: boolean;
}

export interface ScoringWeights {
  latencyWeight: number;
  successWeight: number;
  emaAlpha: number;
}

export interface ProviderMetric {
  total: number;
  successes: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  recentCalls: number;
  lastFailure: string | null;
}

export interface StickySession {
  provider: ProviderName;
  merchantId: string;
  createdAt: number;
  expiresAt: number;
}

export interface ProviderPerformanceConfig {
  weights: {
    latencyWeight: number;
    successRateWeight: number;
    recencyWeight: number;
    stickyBonus: number;
  };
  stickySessionTtlMs: number;
  latencyWindowMs: number;
  defaultProvider: ProviderName;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  latencyWeight: 40,
  successWeight: 60,
  emaAlpha: 0.3,
};

const DEFAULT_PROVIDER_CONFIG: ProviderPerformanceConfig = {
  weights: {
    latencyWeight: 0.4,
    successRateWeight: 0.6,
    recencyWeight: 0.1,
    stickyBonus: 0.05,
  },
  stickySessionTtlMs: 30 * 60 * 1000,
  latencyWindowMs: 10_000,
  defaultProvider: "mtn",
};

const PROVIDER_ORDER: ProviderName[] = ["mtn", "airtel", "orange"];
const SCORE_CACHE_TTL_MS = 60_000;

export class ProviderPerformanceService {
  private config: ProviderPerformanceConfig = structuredClone(DEFAULT_PROVIDER_CONFIG);
  private stickySessions = new Map<string, StickySession>();
  private rankingsCache: {
    rankings: Array<{
      provider: ProviderName;
      compositeScore: number;
      avgLatencyMs: number;
      successRate: number;
      totalCalls: number;
      sticky: boolean;
    }>;
    expiresAt: number;
  } | null = null;

  getScoringConfig(): ProviderPerformanceConfig {
    return structuredClone(this.config);
  }

  updateScoringConfig(
    updates: Partial<ProviderPerformanceConfig> & {
      weights?: Partial<ProviderPerformanceConfig["weights"]>;
    },
  ): void {
    if (updates.weights) {
      this.config.weights = {
        ...this.config.weights,
        ...updates.weights,
      };
    }

    this.config = {
      ...this.config,
      ...updates,
      weights: this.config.weights,
    };

    this.rankingsCache = null;
  }

  setStickySession(merchantId: string, provider: ProviderName): void {
    this.stickySessions.set(merchantId, {
      provider,
      merchantId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.stickySessionTtlMs,
    });
  }

  getStickySession(merchantId: string): StickySession | null {
    const current = this.stickySessions.get(merchantId);
    if (!current) {
      return null;
    }

    if (Date.now() >= current.expiresAt) {
      this.stickySessions.delete(merchantId);
      return null;
    }

    return { ...current };
  }

  clearStickySession(merchantId: string): void {
    this.stickySessions.delete(merchantId);
  }

  clearAllStickySessions(): void {
    this.stickySessions.clear();
  }

  async selectBestProvider(
    excludedProviders: ProviderName[] = [],
    merchantId?: string,
  ): Promise<ProviderName> {
    const excluded = new Set(excludedProviders);

    if (merchantId) {
      const sticky = this.getStickySession(merchantId);
      if (sticky && !excluded.has(sticky.provider)) {
        return sticky.provider;
      }
    }

    if (excludedProviders.length > 0) {
      const fallback = PROVIDER_ORDER.find((provider) => !excluded.has(provider)) ?? this.config.defaultProvider;
      if (merchantId) {
        this.setStickySession(merchantId, fallback);
      }
      return fallback;
    }

    const rankings = await this.getPerformanceRankings(excludedProviders);
    const best = rankings.rankings[0]?.provider ?? this.config.defaultProvider;

    if (merchantId) {
      this.setStickySession(merchantId, best);
    }

    return best;
  }

  async selectBestProviderForMerchant(
    merchantId: string,
    excludedProviders: ProviderName[] = [],
  ): Promise<ProviderName> {
    return this.selectBestProvider(excludedProviders, merchantId);
  }

  private async fetchProviderMetrics(provider: ProviderName): Promise<ProviderMetric> {
    try {
      const { rows } = await pool.query<{
        total: string | null;
        successes: string | null;
        avg_latency: string | null;
        p95_latency: string | null;
        recent_calls: string | null;
        last_failure: string | null;
      }>(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(CASE WHEN success = true THEN 1 ELSE 0 END), 0)::int AS successes,
                AVG(latency_ms) AS avg_latency,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency,
                COUNT(*) AS recent_calls,
                MAX(created_at) AS last_failure
         FROM provider_api_calls
         WHERE provider = $1`,
        [provider],
      );

      const row = rows[0] ?? {} as any;
      const total = Number(row.total ?? 0);
      const successes = Number(row.successes ?? 0);
      const avgLatencyMs = row.avg_latency != null ? Number(row.avg_latency) : null;

      return {
        total,
        successes,
        avgLatencyMs,
        p95LatencyMs: row.p95_latency != null ? Number(row.p95_latency) : null,
        recentCalls: Number(row.recent_calls ?? 0),
        lastFailure: row.last_failure ?? null,
      };
    } catch {
      return {
        total: 0,
        successes: 0,
        avgLatencyMs: null,
        p95LatencyMs: null,
        recentCalls: 0,
        lastFailure: null,
      };
    }
  }

  private computeRanking(
    provider: ProviderName,
    metric: ProviderMetric,
    sticky: boolean,
  ): { provider: ProviderName; compositeScore: number; avgLatencyMs: number; successRate: number; totalCalls: number; sticky: boolean } {
    const total = metric.total;
    const successRate = total > 0 ? metric.successes / total : 0;
    const avgLatencyMs = metric.avgLatencyMs ?? 0;
    const latencyScore =
      total === 0 ? 0 : Math.max(0, 1 - avgLatencyMs / this.config.latencyWindowMs);
    const stickyBonus = sticky ? this.config.weights.stickyBonus : 0;

    const compositeScore =
      successRate * this.config.weights.successRateWeight +
      latencyScore * this.config.weights.latencyWeight +
      stickyBonus;

    return {
      provider,
      compositeScore: Number(compositeScore.toFixed(4)),
      avgLatencyMs: Number(avgLatencyMs.toFixed(2)),
      successRate: Number(successRate.toFixed(4)),
      totalCalls: total,
      sticky,
    };
  }

  async getPerformanceRankings(
    excludedProviders: ProviderName[] = [],
  ): Promise<{
    rankings: Array<{
      provider: ProviderName;
      compositeScore: number;
      avgLatencyMs: number;
      successRate: number;
      totalCalls: number;
      sticky: boolean;
    }>;
    weights: ProviderPerformanceConfig["weights"];
    generatedAt: string;
  }> {
    const excluded = new Set(excludedProviders);

    if (this.rankingsCache && Date.now() < this.rankingsCache.expiresAt) {
      return {
        rankings: this.rankingsCache.rankings,
        weights: this.config.weights,
        generatedAt: new Date().toISOString(),
      };
    }

    const rankings: Array<{
      provider: ProviderName;
      compositeScore: number;
      avgLatencyMs: number;
      successRate: number;
      totalCalls: number;
      sticky: boolean;
    }> = [];

    for (const provider of PROVIDER_ORDER) {
      if (excluded.has(provider)) {
        continue;
      }

      const metric = await this.fetchProviderMetrics(provider);
      rankings.push(this.computeRanking(provider, metric, false));
    }

    rankings.sort((a, b) => {
      const scoreDelta = b.compositeScore - a.compositeScore;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider);
    });

    this.rankingsCache = {
      rankings,
      expiresAt: Date.now() + SCORE_CACHE_TTL_MS,
    };

    return {
      rankings,
      weights: this.config.weights,
      generatedAt: new Date().toISOString(),
    };
  }

  async recordProviderCall(
    provider: ProviderName,
    success: boolean,
    latencyMs: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO provider_api_calls (provider, success, latency_ms, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [provider, success, latencyMs],
    );

    this.rankingsCache = null;
  }
}

export function setStickySession(sessionKey: string, provider: ProviderName): void {
  const service = new ProviderPerformanceService();
  service.setStickySession(sessionKey, provider);
}

export function clearStickySession(sessionKey: string): void {
  const service = new ProviderPerformanceService();
  service.clearStickySession(sessionKey);
}

export function getStickyProvider(sessionKey: string): ProviderName | null {
  const service = new ProviderPerformanceService();
  return service.getStickySession(sessionKey)?.provider ?? null;
}

export async function selectBestProvider(
  sessionKey?: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): Promise<ProviderScore> {
  const service = new ProviderPerformanceService();
  service.updateScoringConfig({
    weights: {
      latencyWeight: weights.latencyWeight / 100,
      successRateWeight: weights.successWeight / 100,
      recencyWeight: 0,
      stickyBonus: 0,
    },
  });

  if (sessionKey) {
    const sticky = getStickyProvider(sessionKey);
    if (sticky) {
      const rankings = await service.getPerformanceRankings();
      const stickyMatch = rankings.rankings.find((r) => r.provider === sticky);
      if (stickyMatch) {
        return {
          provider: stickyMatch.provider,
          score: stickyMatch.compositeScore,
          avgLatencyMs: stickyMatch.avgLatencyMs,
          successRate: stickyMatch.successRate,
          totalCalls: stickyMatch.totalCalls,
          sticky: true,
        };
      }
    }
  }

  const rankings = await service.getPerformanceRankings();
  const best = rankings.rankings[0] ?? {
    provider: "mtn" as ProviderName,
    compositeScore: 0,
    avgLatencyMs: 0,
    successRate: 0,
    totalCalls: 0,
    sticky: false,
  };

  if (sessionKey) {
    setStickySession(sessionKey, best.provider);
  }

  return {
    provider: best.provider,
    score: best.compositeScore,
    avgLatencyMs: best.avgLatencyMs,
    successRate: best.successRate,
    totalCalls: best.totalCalls,
    sticky: !!sessionKey,
  };
}

export async function getProviderRankings(
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): Promise<ProviderScore[]> {
  const service = new ProviderPerformanceService();
  service.updateScoringConfig({
    weights: {
      latencyWeight: weights.latencyWeight / 100,
      successRateWeight: weights.successWeight / 100,
      recencyWeight: 0,
      stickyBonus: 0,
    },
  });

  const rankings = await service.getPerformanceRankings();
  return rankings.rankings.map((r) => ({
    provider: r.provider,
    score: r.compositeScore,
    avgLatencyMs: r.avgLatencyMs,
    successRate: r.successRate,
    totalCalls: r.totalCalls,
    sticky: r.sticky,
  }));
}

export async function updateScoringWeights(
  latencyWeight: number,
  successWeight: number,
  emaAlpha: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_scoring_config (key, value)
     VALUES ('latency_weight', $1),
            ('success_weight', $2),
            ('ema_alpha', $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(latencyWeight), String(successWeight), String(emaAlpha)],
  );
}

export async function loadScoringWeights(): Promise<ScoringWeights> {
  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM provider_scoring_config
       WHERE key IN ('latency_weight', 'success_weight', 'ema_alpha')`,
    );

    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      latencyWeight: parseFloat(map.get("latency_weight") ?? String(DEFAULT_WEIGHTS.latencyWeight)),
      successWeight: parseFloat(map.get("success_weight") ?? String(DEFAULT_WEIGHTS.successWeight)),
      emaAlpha: parseFloat(map.get("ema_alpha") ?? String(DEFAULT_WEIGHTS.emaAlpha)),
    };
  } catch {
    return DEFAULT_WEIGHTS;
  }
}
