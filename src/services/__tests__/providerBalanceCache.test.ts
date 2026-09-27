/**
 * Provider balance cache staleness tests (Issue #634).
 */

import {
  DEFAULT_STALE_THRESHOLD_MS,
  ProviderBalanceCache,
} from "../providerBalanceCache";

describe("ProviderBalanceCache (Issue #634)", () => {
  let now: number;
  let clock: () => number;

  beforeEach(() => {
    now = 1_700_000_000_000;
    clock = () => now;
  });

  const balance = (availableBalance: number) => ({
    availableBalance,
    currency: "XAF",
  });

  it("fetches and caches the balance on first request", async () => {
    const cache = new ProviderBalanceCache({ clock });
    const fetcher = jest.fn().mockResolvedValue(balance(500));

    const entry = await cache.get("mtn", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(entry.availableBalance).toBe(500);
    expect(entry.currency).toBe("XAF");
    expect(entry.fetchedAt).toBe(now);
    expect(entry.ageMs).toBe(0);
    expect(entry.stale).toBe(false);
    expect(entry.warning).toBeUndefined();
  });

  it("serves a fresh cached value without refetching", async () => {
    const cache = new ProviderBalanceCache({ clock });
    const fetcher = jest.fn().mockResolvedValue(balance(500));

    await cache.get("mtn", fetcher);
    now += 60_000;

    const entry = await cache.get("mtn", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(entry.ageMs).toBe(60_000);
    expect(entry.stale).toBe(false);
  });

  it("warns and auto-refreshes data older than one hour", async () => {
    const onStale = jest.fn();
    const cache = new ProviderBalanceCache({ clock, onStale });
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(balance(500))
      .mockResolvedValueOnce(balance(400));

    await cache.get("mtn", fetcher);

    now += DEFAULT_STALE_THRESHOLD_MS + 1;
    expect(cache.isStale("mtn")).toBe(true);
    expect(cache.getAgeMs("mtn")).toBe(DEFAULT_STALE_THRESHOLD_MS + 1);

    const entry = await cache.get("mtn", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(entry.availableBalance).toBe(400);
    expect(entry.stale).toBe(false);
    expect(entry.fetchedAt).toBe(now);
    expect(onStale).toHaveBeenCalledWith(
      "mtn",
      DEFAULT_STALE_THRESHOLD_MS + 1,
    );
  });

  it("treats a value exactly at the threshold as stale", async () => {
    const cache = new ProviderBalanceCache({ clock });
    const fetcher = jest.fn().mockResolvedValue(balance(500));

    await cache.get("mtn", fetcher);
    now += DEFAULT_STALE_THRESHOLD_MS;

    expect(cache.isStale("mtn")).toBe(true);
  });

  it("flags stale metadata when a refresh fails", async () => {
    const cache = new ProviderBalanceCache({ clock });
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(balance(500))
      .mockRejectedValueOnce(new Error("provider down"));

    await cache.get("mtn", fetcher);
    now += DEFAULT_STALE_THRESHOLD_MS + 1_000;

    const entry = await cache.get("mtn", fetcher);

    expect(entry.availableBalance).toBe(500);
    expect(entry.stale).toBe(true);
    expect(entry.warning).toMatch(/Refresh failed/);
  });

  it("de-duplicates concurrent refreshes for the same provider", async () => {
    const cache = new ProviderBalanceCache({ clock });
    let resolveFetch!: (value: ReturnType<typeof balance>) => void;
    const fetcher = jest.fn(
      () =>
        new Promise<ReturnType<typeof balance>>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = cache.get("mtn", fetcher);
    const second = cache.get("mtn", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(balance(123));
    const [a, b] = await Promise.all([first, second]);

    expect(a.availableBalance).toBe(123);
    expect(b.availableBalance).toBe(123);
  });

  it("reports cache statistics including staleness", async () => {
    const cache = new ProviderBalanceCache({ clock });
    const fetcher = jest.fn().mockResolvedValue(balance(1));

    await cache.get("mtn", fetcher);
    now += DEFAULT_STALE_THRESHOLD_MS + 1;
    await cache.get("airtel", fetcher);

    const stats = cache.getStats();

    expect(stats.size).toBe(2);
    expect(stats.staleEntries).toBe(1);
    expect(stats.refreshes).toBe(2);
    expect(stats.oldestAgeMs).toBe(DEFAULT_STALE_THRESHOLD_MS + 1);
  });

  it("invalidates cached entries", async () => {
    const cache = new ProviderBalanceCache({ clock });
    const fetcher = jest.fn().mockResolvedValue(balance(1));

    await cache.get("mtn", fetcher);
    cache.invalidate("mtn");

    expect(cache.peek("mtn")).toBeNull();
    expect(cache.isStale("mtn")).toBe(false);
    expect(cache.getAgeMs("mtn")).toBeNull();

    await cache.get("mtn", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
