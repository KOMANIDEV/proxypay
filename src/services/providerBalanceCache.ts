/**
 * Provider Balance Cache — Issue #634
 *
 * Provider balances are fetched from mobile money APIs/database snapshots that
 * are expensive to poll. Caching them without tracking age risks serving stale
 * data with no warning. This cache:
 *  - stores a fetch timestamp alongside every cached balance
 *  - warns when a cached balance is older than the stale threshold (1 hour)
 *  - automatically refreshes stale entries on request
 *  - exposes staleness metrics via prom-client
 */

import logger from "../utils/logger";
import {
  providerBalanceCacheAgeSeconds,
  providerBalanceCacheHitsTotal,
  providerBalanceCacheMissesTotal,
  providerBalanceCacheRefreshesTotal,
  providerBalanceCacheStaleTotal,
} from "../utils/metrics";

/** Cached balances older than this are considered stale. */
export const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export interface ProviderBalanceValue {
  availableBalance: number;
  currency: string;
}

export interface ProviderBalanceCacheEntry extends ProviderBalanceValue {
  provider: string;
  /** Epoch ms at which the balance was fetched. */
  fetchedAt: number;
  /** Age of the cached value in milliseconds at read time. */
  ageMs: number;
  /** True when the value is older than the stale threshold. */
  stale: boolean;
  /** Human-readable reason populated when the value is stale. */
  warning?: string;
}

export type ProviderBalanceFetcher = () => Promise<ProviderBalanceValue>;

export interface ProviderBalanceCacheOptions {
  /** Age (ms) after which a cached balance is considered stale. Default 1 hour. */
  staleThresholdMs?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  clock?: () => number;
  /** Callback invoked whenever stale data is detected before a refresh. */
  onStale?: (provider: string, ageMs: number) => void;
}

export interface ProviderBalanceCacheStats {
  size: number;
  staleEntries: number;
  oldestAgeMs: number | null;
  staleDetections: number;
  refreshes: number;
}

interface CacheRecord {
  value: ProviderBalanceValue;
  fetchedAt: number;
}


function describeStale(ageMs: number, thresholdMs: number): string {
  const ageMinutes = Math.round(ageMs / 60000);
  const thresholdMinutes = Math.round(thresholdMs / 60000);
  return `Cached balance is stale (${ageMinutes} min old, threshold ${thresholdMinutes} min)`;
}

export class ProviderBalanceCache {
  private readonly entries = new Map<string, CacheRecord>();
  private readonly inflight = new Map<string, Promise<ProviderBalanceCacheEntry>>();
  private readonly staleThresholdMs: number;
  private readonly clock: () => number;
  private readonly onStale?: (provider: string, ageMs: number) => void;
  private staleDetections = 0;
  private refreshes = 0;

  constructor(options: ProviderBalanceCacheOptions = {}) {
    this.staleThresholdMs =
      options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.clock = options.clock ?? Date.now;
    this.onStale = options.onStale;
  }

  /**
   * Return the cached balance for a provider, automatically refreshing when the
   * entry is missing or stale. Concurrent callers share a single refresh.
   */
  async get(
    provider: string,
    fetcher: ProviderBalanceFetcher,
  ): Promise<ProviderBalanceCacheEntry> {
    const record = this.entries.get(provider);

    if (record && !this.isStaleAt(record.fetchedAt)) {
      providerBalanceCacheHitsTotal.inc({ provider });
      return this.toEntry(provider, record);
    }

    if (record) {
      const ageMs = this.clock() - record.fetchedAt;
      this.staleDetections += 1;
      providerBalanceCacheStaleTotal.inc({ provider });
      this.onStale?.(provider, ageMs);
      logger.warn(
        { provider, ageMs, staleThresholdMs: this.staleThresholdMs },
        "Provider balance cache is stale — auto-refreshing",
      );
    } else {
      providerBalanceCacheMissesTotal.inc({ provider });
    }

    return this.refresh(provider, fetcher);
  }

  /**
   * Force a refresh regardless of age. Concurrent refreshes for the same
   * provider are de-duplicated into a single fetch.
   */
  async refresh(
    provider: string,
    fetcher: ProviderBalanceFetcher,
  ): Promise<ProviderBalanceCacheEntry> {
    const existing = this.inflight.get(provider);
    if (existing) return existing;

    const promise = this.performRefresh(provider, fetcher);
    this.inflight.set(provider, promise);

    try {
      return await promise;
    } finally {
      this.inflight.delete(provider);
    }
  }

  /** Read a cached entry without triggering a refresh. */
  peek(provider: string): ProviderBalanceCacheEntry | null {
    const record = this.entries.get(provider);
    return record ? this.toEntry(provider, record) : null;
  }

  /** True when a cached entry exists and is older than the stale threshold. */
  isStale(provider: string): boolean {
    const record = this.entries.get(provider);
    return record ? this.isStaleAt(record.fetchedAt) : false;
  }

  /** Age of the cached entry in ms, or null when nothing is cached. */
  getAgeMs(provider: string): number | null {
    const record = this.entries.get(provider);
    return record ? Math.max(0, this.clock() - record.fetchedAt) : null;
  }

  /** Drop cached data for one provider, or all providers when omitted. */
  invalidate(provider?: string): void {
    if (provider) {
      this.entries.delete(provider);
      providerBalanceCacheAgeSeconds.remove({ provider });
      return;
    }
    this.entries.clear();
  }

  /** Cache diagnostics for health endpoints and tests. */
  getStats(): ProviderBalanceCacheStats {
    let staleEntries = 0;
    let oldestAgeMs: number | null = null;

    for (const record of this.entries.values()) {
      const ageMs = Math.max(0, this.clock() - record.fetchedAt);
      if (this.isStaleAt(record.fetchedAt)) staleEntries += 1;
      if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs;
    }

    return {
      size: this.entries.size,
      staleEntries,
      oldestAgeMs,
      staleDetections: this.staleDetections,
      refreshes: this.refreshes,
    };
  }

  private async performRefresh(
    provider: string,
    fetcher: ProviderBalanceFetcher,
  ): Promise<ProviderBalanceCacheEntry> {
    try {
      const value = await fetcher();
      const fetchedAt = this.clock();
      const record: CacheRecord = { value, fetchedAt };
      this.entries.set(provider, record);
      this.refreshes += 1;
      providerBalanceCacheRefreshesTotal.inc({ provider, result: "success" });
      return this.toEntry(provider, record);
    } catch (error) {
      providerBalanceCacheRefreshesTotal.inc({ provider, result: "error" });
      logger.error(
        { provider, err: error },
        "Failed to refresh provider balance cache",
      );

      const cached = this.entries.get(provider);
      if (cached) {
        // Serve the previous value but clearly flag it as stale.
        const entry = this.toEntry(provider, cached);
        return {
          ...entry,
          stale: true,
          warning: `Refresh failed; serving stale balance. ${
            entry.warning ?? ""
          }`.trim(),
        };
      }

      throw error;
    }
  }

  private isStaleAt(fetchedAt: number): boolean {
    return this.clock() - fetchedAt >= this.staleThresholdMs;
  }

  private toEntry(provider: string, record: CacheRecord): ProviderBalanceCacheEntry {
    const ageMs = Math.max(0, this.clock() - record.fetchedAt);
    const stale = this.isStaleAt(record.fetchedAt);

    providerBalanceCacheAgeSeconds.set({ provider }, ageMs / 1000);

    return {
      ...record.value,
      provider,
      fetchedAt: record.fetchedAt,
      ageMs,
      stale,
      warning: stale ? describeStale(ageMs, this.staleThresholdMs) : undefined,
    };
  }
}

/** Process-wide provider balance cache. */
export const providerBalanceCache = new ProviderBalanceCache();

export default providerBalanceCache;

