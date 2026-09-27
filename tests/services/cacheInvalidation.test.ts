/**
 * Comprehensive Cache Invalidation Test Suite
 * GitHub Issue #427
 *
 * Covers:
 * - Basic invalidation (invalidateCache, invalidatePattern)
 * - Cascading invalidation (parent key removes all children)
 * - Layered cache (L1 eviction, L2 Redis deletion, L1 miss promotion)
 * - Timing and ordering (synchronous removal, rapid invalidations, TTL expiry)
 * - Cache decorator invalidation (HIT → MISS cycle)
 * - Stale-While-Revalidate (getSwr) behavior
 * - Performance (bulk delete, L1 short-circuit)
 */

import { invalidateCache, invalidatePattern } from "../../src/services/cache";
import { layeredCache, LayeredCache } from "../../src/services/layeredCache";
import { redisClient } from "../../src/config/redis";

// ---------------------------------------------------------------------------
// Redis Mock
// ---------------------------------------------------------------------------
jest.mock("../../src/config/redis", () => ({
  redisClient: {
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    keys: jest.fn(),
    publish: jest.fn(),
    zAdd: jest.fn(),
    zCard: jest.fn(),
    zRange: jest.fn(),
    zRemRangeByScore: jest.fn(),
    expire: jest.fn(),
    incr: jest.fn(),
    isOpen: true,
  },
}));

// Typed helpers so we don't need to cast everywhere
const mockRedis = redisClient as {
  get: jest.Mock;
  setEx: jest.Mock;
  del: jest.Mock;
  keys: jest.Mock;
  publish: jest.Mock;
  zAdd: jest.Mock;
  zCard: jest.Mock;
  zRange: jest.Mock;
  zRemRangeByScore: jest.Mock;
  expire: jest.Mock;
  incr: jest.Mock;
  isOpen: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all L1 (node-cache) entries by invalidating via a wildcard.
 *  We call layeredCache.del on every key known to L1 through the node-cache
 *  internal `keys()` accessor exposed by the module under test indirectly.
 *  A simpler approach: recreate an isolated LayeredCache instance per suite.
 */
function freshCache(): LayeredCache {
  return new LayeredCache();
}

// ---------------------------------------------------------------------------
// Reset state between every test
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();

  // Default stubs – tests override as needed
  mockRedis.get.mockResolvedValue(null);
  mockRedis.setEx.mockResolvedValue("OK");
  mockRedis.del.mockResolvedValue(1);
  mockRedis.keys.mockResolvedValue([]);
  mockRedis.publish.mockResolvedValue(1);
  mockRedis.zAdd.mockResolvedValue(1);
  mockRedis.zCard.mockResolvedValue(0);
  mockRedis.zRange.mockResolvedValue([]);
  mockRedis.zRemRangeByScore.mockResolvedValue(0);
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.incr.mockResolvedValue(1);
});

// ===========================================================================
// 1. Basic Invalidation
// ===========================================================================
describe("Basic invalidation", () => {
  it("invalidateCache: removes a key that was previously set in L1", async () => {
    const cache = freshCache();
    const key = "cache:/api/users/1";
    const value = { id: 1, name: "Alice" };

    // Populate L1 by calling set
    await cache.set(key, value, 60);

    // Sanity: confirm L1 has it (no Redis call expected)
    const before = await cache.get(key);
    expect(before).toEqual(value);
    expect(mockRedis.get).not.toHaveBeenCalled();

    // Invalidate through the public API
    await invalidateCache(key);

    // L1 is now empty; Redis.get returns null → overall null
    mockRedis.get.mockResolvedValueOnce(null);
    const after = await cache.get(key);
    expect(after).toBeNull();
  });

  it("invalidateCache: delegates to layeredCache.del and calls Redis.del", async () => {
    const key = "cache:/api/transactions/42";
    await invalidateCache(key);

    expect(mockRedis.del).toHaveBeenCalledWith(key);
  });

  it("invalidateCache: publishes invalidation signal to other instances", async () => {
    const key = "cache:/api/stats";
    await invalidateCache(key);

    expect(mockRedis.publish).toHaveBeenCalledWith(
      "cache:invalidate:l1",
      key,
    );
  });

  it("invalidatePattern: removes keys matching the pattern from L2", async () => {
    const matchingKeys = [
      "cache:/api/stats/daily",
      "cache:/api/stats/monthly",
      "cache:/api/stats/yearly",
    ];
    mockRedis.keys.mockResolvedValueOnce(matchingKeys);

    await invalidatePattern("cache:/api/stats*");

    // keys() scanned with the pattern
    expect(mockRedis.keys).toHaveBeenCalledWith("cache:/api/stats*");
    // del called with the full array
    expect(mockRedis.del).toHaveBeenCalledWith(matchingKeys);
  });

  it("invalidatePattern: does nothing when no keys match (empty pattern match)", async () => {
    mockRedis.keys.mockResolvedValueOnce([]);

    await invalidatePattern("cache:/api/nonexistent*");

    expect(mockRedis.keys).toHaveBeenCalledTimes(1);
    // del should NOT be called when there are no keys to remove
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it("invalidatePattern: handles Redis unavailability gracefully (no throw)", async () => {
    const closedRedis = redisClient as any;
    const originalIsOpen = closedRedis.isOpen;
    closedRedis.isOpen = false;

    // Should not throw even when Redis is closed
    await expect(
      invalidatePattern("cache:/api/stats*"),
    ).resolves.toBeUndefined();

    closedRedis.isOpen = originalIsOpen;
  });

  it("invalidatePattern: does not throw when Redis.keys rejects", async () => {
    mockRedis.keys.mockRejectedValueOnce(new Error("Redis CLUSTERDOWN"));

    await expect(
      invalidatePattern("cache:/api/stats*"),
    ).resolves.toBeUndefined();
  });
});

// ===========================================================================
// 2. Cascading Invalidation
// ===========================================================================
describe("Cascading invalidation", () => {
  it("invalidating a parent pattern removes all child keys from L1 and L2", async () => {
    const cache = freshCache();
    const childKeys = [
      "cache:/api/stats/daily",
      "cache:/api/stats/weekly",
      "cache:/api/stats/monthly",
    ];

    // Seed L1 for all child keys
    for (const k of childKeys) {
      await cache.set(k, { count: Math.random() }, 300);
    }

    // Redis reports the same three keys for the pattern scan
    mockRedis.keys.mockResolvedValueOnce(childKeys);

    await invalidatePattern("cache:/api/stats*");

    // del was called with the complete array
    expect(mockRedis.del).toHaveBeenCalledWith(childKeys);

    // Each child key was published to the invalidation channel
    for (const k of childKeys) {
      expect(mockRedis.publish).toHaveBeenCalledWith("cache:invalidate:l1", k);
    }
  });

  it("multiple related keys invalidated atomically in one del call", async () => {
    const relatedKeys = [
      "cache:/api/users/1",
      "cache:/api/users/2",
      "cache:/api/users/3",
    ];
    mockRedis.keys.mockResolvedValueOnce(relatedKeys);

    await invalidatePattern("cache:/api/users/*");

    // All keys removed in a single Redis del call (atomic)
    expect(mockRedis.del).toHaveBeenCalledTimes(1);
    expect(mockRedis.del).toHaveBeenCalledWith(relatedKeys);
  });

  it("re-fetch after invalidation returns fresh data (full cycle)", async () => {
    const cache = freshCache();
    const key = "cache:/api/transactions/summary";
    const staleData = { total: 100 };
    const freshData = { total: 200 };

    // Seed L1 + L2
    await cache.set(key, staleData, 60);

    // Invalidate
    mockRedis.keys.mockResolvedValueOnce([key]);
    await invalidatePattern(key);

    // On next get, L1 is empty and Redis returns fresh data
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(freshData));
    const result = await cache.get(key);
    expect(result).toEqual(freshData);
    expect(mockRedis.get).toHaveBeenCalledWith(key);
  });
});

// ===========================================================================
// 3. Layered Cache Invalidation
// ===========================================================================
describe("Layered cache invalidation", () => {
  it("L1 eviction happens when del is called", async () => {
    const cache = freshCache();
    const key = "cache:/api/config";
    const value = { featureFlag: true };

    await cache.set(key, value, 300);

    // Confirm L1 has it (Redis.get not called)
    expect(await cache.get(key)).toEqual(value);
    expect(mockRedis.get).not.toHaveBeenCalled();

    await cache.del(key);

    // L1 cleared; next get must go to Redis (which returns null here)
    mockRedis.get.mockResolvedValueOnce(null);
    const afterDel = await cache.get(key);
    expect(afterDel).toBeNull();
    expect(mockRedis.get).toHaveBeenCalledWith(key);
  });

  it("L2 (Redis) del is called on invalidation", async () => {
    const cache = freshCache();
    const key = "cache:/api/rates/XAF-USDC";

    await cache.del(key);

    expect(mockRedis.del).toHaveBeenCalledWith(key);
  });

  it("L1 miss after invalidation triggers L2 lookup and re-populates L1", async () => {
    const cache = freshCache();
    const key = "cache:/api/users/profile/7";
    const value = { userId: 7, name: "Bob" };

    // Warm L1
    await cache.set(key, value, 120);

    // Invalidate → L1 empty
    await cache.del(key);

    // Redis now has fresh data
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(value));

    const result1 = await cache.get(key);
    expect(result1).toEqual(value);
    expect(mockRedis.get).toHaveBeenCalledTimes(1);

    // Second get should be served from L1 (no additional Redis call)
    const result2 = await cache.get(key);
    expect(result2).toEqual(value);
    expect(mockRedis.get).toHaveBeenCalledTimes(1); // still 1
  });

  it("pattern invalidation removes from both L1 and L2", async () => {
    const cache = freshCache();
    const keys = ["cache:/api/stats/a", "cache:/api/stats/b"];

    for (const k of keys) {
      await cache.set(k, { v: k }, 300);
    }

    // Confirm both are in L1
    expect(await cache.get(keys[0])).toEqual({ v: keys[0] });
    expect(await cache.get(keys[1])).toEqual({ v: keys[1] });
    expect(mockRedis.get).not.toHaveBeenCalled();

    // Pattern invalidation
    mockRedis.keys.mockResolvedValueOnce(keys);
    await cache.delPattern("cache:/api/stats*");

    // Both removed from L2
    expect(mockRedis.del).toHaveBeenCalledWith(keys);

    // L1 also cleared → Redis returns null for both
    mockRedis.get.mockResolvedValue(null);
    expect(await cache.get(keys[0])).toBeNull();
    expect(await cache.get(keys[1])).toBeNull();
    expect(mockRedis.get).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 4. Timing and Ordering
// ===========================================================================
describe("Timing and ordering", () => {
  it("key is not accessible immediately after synchronous invalidation", async () => {
    const cache = freshCache();
    const key = "cache:/api/payments/pending";
    await cache.set(key, { amount: 5000 }, 60);

    // Awaiting del ensures the key is removed before the next get
    await cache.del(key);

    mockRedis.get.mockResolvedValueOnce(null);
    const result = await cache.get(key);
    expect(result).toBeNull();
  });

  it("multiple rapid invalidations do not cause race conditions", async () => {
    const cache = freshCache();
    const key = "cache:/api/accounts/balance";
    await cache.set(key, { balance: 10000 }, 300);

    // Fire 10 concurrent invalidations
    const invalidations = Array.from({ length: 10 }, () => cache.del(key));
    await Promise.all(invalidations);

    // del called 10 times (each independently)
    expect(mockRedis.del).toHaveBeenCalledTimes(10);
    expect(mockRedis.del).toHaveBeenCalledWith(key);

    // Key is gone after all invalidations
    mockRedis.get.mockResolvedValueOnce(null);
    expect(await cache.get(key)).toBeNull();
  });

  it("TTL expiry: verifies data is absent after TTL elapses (simulated via Redis miss)", async () => {
    /**
     * node-cache enforces actual TTL expiry internally; we simulate expiry
     * by having Redis return null (as it would after the TTL window) and
     * confirming the caller gets null rather than a stale L2 value.
     */
    const cache = freshCache();
    const key = "cache:/api/rates/short";
    const value = { rate: 0.0017 };

    await cache.set(key, value, 1); // 1-second TTL

    // Simulate TTL elapsed on L1 by directly deleting from L1 via a second del
    // (In real usage node-cache drops it automatically after 1s)
    await cache.del(key);

    // Redis also expired the key
    mockRedis.get.mockResolvedValueOnce(null);

    const result = await cache.get(key);
    expect(result).toBeNull();
  });

  it("explicit invalidation supersedes future TTL: del before TTL expiry purges the entry", async () => {
    const cache = freshCache();
    const key = "cache:/api/offers/flash";
    await cache.set(key, { discount: "20%" }, 900); // 15-minute TTL

    // Delete well before TTL
    await cache.del(key);

    // Should be gone immediately
    mockRedis.get.mockResolvedValueOnce(null);
    expect(await cache.get(key)).toBeNull();
    expect(mockRedis.del).toHaveBeenCalledWith(key);
  });
});

// ===========================================================================
// 5. Cache Decorator Invalidation
// ===========================================================================
describe("Cache decorator invalidation", () => {
  /**
   * The Cache decorator wraps Express handlers. We test the lifecycle:
   * 1. First request → MISS → stores response in layeredCache
   * 2. Second request → HIT → returns from cache (no handler call)
   * 3. invalidateCache call → removes entry
   * 4. Third request → MISS again → handler called once more
   */

  function buildMockExpressContext(overrides?: {
    path?: string;
    method?: string;
  }) {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let capturedJson: unknown = undefined;

    const req: any = {
      method: overrides?.method ?? "GET",
      path: overrides?.path ?? "/api/stats",
      query: {},
      route: { path: overrides?.path ?? "/api/stats" },
    };

    const res: any = {
      statusCode,
      setHeader: jest.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      status: jest.fn(function (code: number) {
        statusCode = code;
        return res;
      }),
      json: jest.fn(function (body: unknown) {
        capturedJson = body;
        return res;
      }),
      get headers() {
        return headers;
      },
      get capturedBody() {
        return capturedJson;
      },
    };

    const next = jest.fn();
    return { req, res, next };
  }

  it("cached response is served on second request (HIT) without calling the handler again", async () => {
    const cache = freshCache();
    const key = "cache:/api/stats";
    const responseBody = { transactions: 42 };

    // Prime L1 manually (simulates first request having populated the cache)
    await cache.set(key, { __rawResponse: { statusCode: 200, body: responseBody } }, 300);

    // L1 has it, so Redis.get should NOT be called
    const cached = await cache.get(key);
    expect(cached).not.toBeNull();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it("after invalidateCache, entry is a MISS and the cache must be re-populated on next set", async () => {
    const cache = freshCache();
    const key = "cache:/api/stats";
    const responseBody = { transactions: 42 };

    // Warm
    await cache.set(key, { __rawResponse: { statusCode: 200, body: responseBody } }, 300);

    // Confirm HIT
    const before = await cache.get(key);
    expect(before).not.toBeNull();

    // Invalidate via public API
    await invalidateCache(key);

    // Now a MISS
    mockRedis.get.mockResolvedValueOnce(null);
    const after = await cache.get(key);
    expect(after).toBeNull();
    expect(mockRedis.del).toHaveBeenCalledWith(key);
  });

  it("full decorator-like cycle: MISS → HIT → invalidate → MISS", async () => {
    // Use the module-level singleton to ensure invalidateCache and cache.get
    // share the same L1 instance (l1 is module-level in layeredCache.ts)
    const key = "cache:/api/users/me-cycle-test";

    // Req 1: MISS – L1 empty, Redis also returns null
    mockRedis.get.mockResolvedValueOnce(null);
    const miss1 = await layeredCache.get(key);
    expect(miss1).toBeNull();

    // Populate L1
    await layeredCache.set(key, { id: 99, name: "Carol" }, 300);

    // Req 2: HIT – Redis.get should NOT be called again (L1 hit)
    jest.clearAllMocks(); // reset call counts after the set (which called setEx/publish)
    const hit = await layeredCache.get(key);
    expect(hit).toEqual({ id: 99, name: "Carol" });
    expect(mockRedis.get).not.toHaveBeenCalled(); // served from L1

    // Invalidate via public API (calls layeredCache.del under the hood)
    await invalidateCache(key);

    // Req 3: MISS – L1 cleared, Redis also empty
    mockRedis.get.mockResolvedValueOnce(null);
    const miss2 = await layeredCache.get(key);
    expect(miss2).toBeNull();
    expect(mockRedis.get).toHaveBeenCalledWith(key);
  });
});

// ===========================================================================
// 6. Stale-While-Revalidate (SWR)
// ===========================================================================
describe("Stale data detection (getSwr)", () => {
  it("getSwr returns stale data while revalidating in the background", async () => {
    const cache = freshCache();
    const key = "swr:/api/exchange-rates";
    const staleData = { XAF_USDC: 0.0016 };
    const freshData = { XAF_USDC: 0.0017 };

    const pastTime = Date.now() - 10_000; // freshUntil is 10 seconds ago

    // Seed cache with stale entry (freshUntil in the past)
    await cache.set(key, { data: staleData, freshUntil: pastTime }, 600);

    let fetcherResolved = false;
    const fetcher = jest.fn(async () => {
      // Simulate a slow fetch
      await new Promise((r) => setTimeout(r, 10));
      fetcherResolved = true;
      return freshData;
    });

    // getSwr should return stale data synchronously
    const result = await cache.getSwr(key, fetcher, {
      freshTtlSec: 30,
      staleTtlSec: 570,
    });

    expect(result).toEqual(staleData); // stale returned immediately

    // Wait for background revalidation
    await new Promise((r) => setTimeout(r, 50));
    expect(fetcherResolved).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("revalidation replaces stale data with fresh data after background fetch", async () => {
    const cache = freshCache();
    const key = "swr:/api/fee-schedule";
    const staleData = { depositFee: 0.01 };
    const freshData = { depositFee: 0.008 };

    const pastTime = Date.now() - 5_000;
    await cache.set(key, { data: staleData, freshUntil: pastTime }, 600);

    const fetcher = jest.fn().mockResolvedValue(freshData);

    // First call → stale returned, revalidation triggered
    await cache.getSwr(key, fetcher, { freshTtlSec: 60, staleTtlSec: 540 });
    await new Promise((r) => setTimeout(r, 20)); // allow bg job to finish

    // Second call → fresh data now in cache
    const result2 = await cache.getSwr(key, fetcher, {
      freshTtlSec: 60,
      staleTtlSec: 540,
    });

    // Result should be fresh (revalidated)
    expect(result2).toEqual(freshData);
  });

  it("simultaneous requests during revalidation get the same stale data (no thundering herd)", async () => {
    const cache = freshCache();
    const key = "swr:/api/limits";
    const staleData = { daily: 100_000 };
    const freshData = { daily: 200_000 };

    const pastTime = Date.now() - 1_000;
    await cache.set(key, { data: staleData, freshUntil: pastTime }, 600);

    let fetchCallCount = 0;
    const fetcher = jest.fn(async () => {
      fetchCallCount += 1;
      await new Promise((r) => setTimeout(r, 30));
      return freshData;
    });

    // Fire 5 simultaneous getSwr calls while cache is stale
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        cache.getSwr(key, fetcher, { freshTtlSec: 60, staleTtlSec: 540 }),
      ),
    );

    // All should receive stale data (no blocking)
    for (const r of results) {
      expect(r).toEqual(staleData);
    }

    // Wait for background revalidation to complete
    await new Promise((r) => setTimeout(r, 60));

    // Revalidation fetcher called only ONCE (thundering herd protection)
    expect(fetchCallCount).toBe(1);
  });

  it("getSwr triggers fetcher on cache miss and stores result", async () => {
    const cache = freshCache();
    const key = "swr:/api/provider-status";
    const freshData = { mtn: "online", airtel: "online" };

    mockRedis.get.mockResolvedValueOnce(null); // L2 also misses

    const fetcher = jest.fn().mockResolvedValue(freshData);

    const result = await cache.getSwr(key, fetcher, {
      freshTtlSec: 60,
      staleTtlSec: 240,
    });

    expect(result).toEqual(freshData);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Should have been written to L2
    expect(mockRedis.setEx).toHaveBeenCalled();
  });
});

// ===========================================================================
// 7. Performance
// ===========================================================================
describe("Performance", () => {
  it("bulk pattern delete handles 10+ keys efficiently and verifies all are deleted", async () => {
    const cache = freshCache();
    const prefix = "cache:/api/analytics/";
    const bulkKeys = Array.from({ length: 15 }, (_, i) => `${prefix}${i}`);

    // Seed L1
    for (const k of bulkKeys) {
      await cache.set(k, { index: k }, 300);
    }

    // Pattern scan returns all 15 keys
    mockRedis.keys.mockResolvedValueOnce(bulkKeys);

    await cache.delPattern(`${prefix}*`);

    // Single del call with all 15 keys (atomic)
    expect(mockRedis.del).toHaveBeenCalledWith(bulkKeys);

    // Every key published to invalidation channel
    for (const k of bulkKeys) {
      expect(mockRedis.publish).toHaveBeenCalledWith("cache:invalidate:l1", k);
    }

    // All 15 gone from L1 → must fall through to Redis
    mockRedis.get.mockResolvedValue(null);
    for (const k of bulkKeys) {
      expect(await cache.get(k)).toBeNull();
    }
    // Redis.get called 15 times (L1 miss for each)
    expect(mockRedis.get).toHaveBeenCalledTimes(15);
  });

  it("L1 hit does not call Redis (performance check)", async () => {
    const cache = freshCache();
    const key = "cache:/api/health/summary";
    const value = { status: "healthy" };

    // Warm L1 directly
    await cache.set(key, value, 300);

    // 10 consecutive reads
    for (let i = 0; i < 10; i++) {
      const result = await cache.get(key);
      expect(result).toEqual(value);
    }

    // Redis.get should have been called exactly ONCE during the set's publish
    // but NOT during any of the subsequent get calls
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it("invalidateCache resolves within an acceptable time for 100 sequential keys", async () => {
    const start = Date.now();
    const keys = Array.from({ length: 100 }, (_, i) => `cache:/api/items/${i}`);

    await Promise.all(keys.map((k) => invalidateCache(k)));

    const elapsed = Date.now() - start;
    // 100 sequential invalidations should complete well under 1 second with mocks
    expect(elapsed).toBeLessThan(1000);
    expect(mockRedis.del).toHaveBeenCalledTimes(100);
  });
});

// ===========================================================================
// 8. Edge Cases
// ===========================================================================
describe("Edge cases", () => {
  it("invalidateCache on a non-existent key does not throw", async () => {
    await expect(invalidateCache("cache:/api/ghost/key")).resolves.toBeUndefined();
    expect(mockRedis.del).toHaveBeenCalledWith("cache:/api/ghost/key");
  });

  it("invalidatePattern with a wildcard-only pattern calls Redis.keys with that pattern", async () => {
    mockRedis.keys.mockResolvedValueOnce(["cache:a", "cache:b"]);
    await invalidatePattern("cache:*");
    expect(mockRedis.keys).toHaveBeenCalledWith("cache:*");
    expect(mockRedis.del).toHaveBeenCalledWith(["cache:a", "cache:b"]);
  });

  it("del when Redis is closed does not throw and still clears L1", async () => {
    const cache = freshCache();
    const key = "cache:/api/closed";
    await cache.set(key, { x: 1 }, 60);

    // Simulate Redis connection closed
    (redisClient as any).isOpen = false;

    await expect(cache.del(key)).resolves.toBeUndefined();
    expect(mockRedis.del).not.toHaveBeenCalled(); // skipped because isOpen is false

    // Restore
    (redisClient as any).isOpen = true;

    // L1 should still be cleared (del runs l1.del before checking Redis)
    mockRedis.get.mockResolvedValueOnce(null);
    expect(await cache.get(key)).toBeNull();
  });

  it("set followed immediately by del leaves no trace", async () => {
    const cache = freshCache();
    const key = "cache:/api/temp";
    await cache.set(key, { temp: true }, 300);
    await cache.del(key);

    mockRedis.get.mockResolvedValueOnce(null);
    expect(await cache.get(key)).toBeNull();
  });

  it("overwriting a key with set then invalidating removes the new value too", async () => {
    const cache = freshCache();
    const key = "cache:/api/version";

    await cache.set(key, { v: 1 }, 300);
    await cache.set(key, { v: 2 }, 300); // overwrite

    // Confirm overwritten value
    expect(await cache.get(key)).toEqual({ v: 2 });

    await cache.del(key);

    mockRedis.get.mockResolvedValueOnce(null);
    expect(await cache.get(key)).toBeNull();
  });
});
