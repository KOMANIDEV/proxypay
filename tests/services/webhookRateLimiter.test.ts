import {
  checkWebhookRateLimit,
  recordWebhookFailure,
  recordWebhookSuccess,
  getWebhookDeliveryStatus,
  DEFAULT_RATE_LIMIT_CONFIG,
  RateLimitConfig,
} from '../../src/services/webhookRateLimiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal in-memory Redis mock that supports the sorted-set and
 * string operations used by the rate limiter.
 */
function buildRedisMock() {
  const sortedSets: Map<string, Map<string, number>> = new Map();
  const strings: Map<string, string> = new Map();
  const expirations: Map<string, number> = new Map(); // not enforced, just stored

  const mock = {
    isOpen: true as boolean,

    // String ops
    async get(key: string): Promise<string | null> {
      return strings.get(key) ?? null;
    },
    async incr(key: string): Promise<number> {
      const prev = parseInt(strings.get(key) ?? '0', 10);
      const next = prev + 1;
      strings.set(key, String(next));
      return next;
    },
    async del(key: string): Promise<number> {
      const existed = strings.has(key) || sortedSets.has(key);
      strings.delete(key);
      sortedSets.delete(key);
      return existed ? 1 : 0;
    },
    async expire(key: string, seconds: number): Promise<boolean> {
      expirations.set(key, seconds);
      return true;
    },

    // Sorted-set ops
    async zRemRangeByScore(key: string, min: string | number, max: number): Promise<number> {
      const set = sortedSets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const [member, score] of set.entries()) {
        const minNum = min === '-inf' ? -Infinity : Number(min);
        if (score >= minNum && score <= max) {
          set.delete(member);
          removed++;
        }
      }
      return removed;
    },
    async zCard(key: string): Promise<number> {
      return sortedSets.get(key)?.size ?? 0;
    },
    async zAdd(key: string, entry: { score: number; value: string }): Promise<number> {
      if (!sortedSets.has(key)) sortedSets.set(key, new Map());
      sortedSets.get(key)!.set(entry.value, entry.score);
      return 1;
    },
    /**
     * zRange with withScores=true returns interleaved [member, score, member, score…]
     * matching the redis node client behaviour the production code relies on.
     */
    async zRange(
      key: string,
      start: number,
      stop: number,
      options?: { withScores?: boolean },
    ): Promise<(string | number)[]> {
      const set = sortedSets.get(key);
      if (!set || set.size === 0) return [];

      const sorted = [...set.entries()].sort((a, b) => a[1] - b[1]);
      const normalEnd = stop < 0 ? sorted.length + stop : stop;
      const slice = sorted.slice(start, normalEnd + 1);

      if (options?.withScores) {
        return slice.flatMap(([member, score]) => [member, score]);
      }
      return slice.map(([member]) => member);
    },

    // Test helpers (not part of the real Redis interface)
    _strings: strings,
    _sortedSets: sortedSets,
  };

  return mock;
}

type RedisMock = ReturnType<typeof buildRedisMock>;

// ---------------------------------------------------------------------------
// Tests — checkWebhookRateLimit
// ---------------------------------------------------------------------------

describe('checkWebhookRateLimit', () => {
  const cfg: RateLimitConfig = {
    maxDeliveries: 3,
    windowSecs: 60,
    failureThreshold: 2,
    adaptiveMultiplier: 0.5,
  };

  it('allows delivery when under the limit', async () => {
    const redis = buildRedisMock();
    const result = await checkWebhookRateLimit('merchant-1', cfg, redis as any);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2); // 3 max − 0 existing − 1 just added
    expect(result.isAdaptive).toBe(false);
    expect(result.resetAt).toBeInstanceOf(Date);
    expect(result.retryAfterSecs).toBeUndefined();
  });

  it('tracks remaining count correctly as deliveries accumulate', async () => {
    const redis = buildRedisMock();

    const r1 = await checkWebhookRateLimit('merchant-1', cfg, redis as any);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await checkWebhookRateLimit('merchant-1', cfg, redis as any);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await checkWebhookRateLimit('merchant-1', cfg, redis as any);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('blocks delivery once the limit is reached', async () => {
    const redis = buildRedisMock();

    // Fill up all 3 slots
    for (let i = 0; i < 3; i++) {
      await checkWebhookRateLimit('merchant-1', cfg, redis as any);
    }

    // 4th call should be blocked
    const result = await checkWebhookRateLimit('merchant-1', cfg, redis as any);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSecs).toBeGreaterThanOrEqual(1);
    expect(result.isAdaptive).toBe(false);
  });

  it('applies adaptive rate limiting when failure threshold is exceeded', async () => {
    const redis = buildRedisMock();

    // Simulate 2 failures (= failureThreshold)
    redis._strings.set('webhook:failures:merchant-adaptive', '2');

    // effectiveMax = floor(3 * 0.5) = 1
    const r1 = await checkWebhookRateLimit('merchant-adaptive', cfg, redis as any);
    expect(r1.allowed).toBe(true);
    expect(r1.isAdaptive).toBe(true);
    expect(r1.remaining).toBe(0); // 1 max − 0 existing − 1 just added

    // 2nd call should be blocked under the reduced limit
    const r2 = await checkWebhookRateLimit('merchant-adaptive', cfg, redis as any);
    expect(r2.allowed).toBe(false);
    expect(r2.isAdaptive).toBe(true);
  });

  it('adaptive multiplier result is always at least 1', async () => {
    const redis = buildRedisMock();

    const tightCfg: RateLimitConfig = {
      maxDeliveries: 1,
      windowSecs: 60,
      failureThreshold: 1,
      adaptiveMultiplier: 0.1, // floor(1 * 0.1) = 0 → clamped to 1
    };

    redis._strings.set('webhook:failures:merchant-clamp', '1');

    const r1 = await checkWebhookRateLimit('merchant-clamp', tightCfg, redis as any);
    expect(r1.allowed).toBe(true); // clamped effective max = 1, so first call allowed
    expect(r1.isAdaptive).toBe(true);
  });

  it('fails open when Redis is unavailable (isOpen = false)', async () => {
    const redis = buildRedisMock();
    redis.isOpen = false;

    const result = await checkWebhookRateLimit('merchant-1', cfg, redis as any);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(cfg.maxDeliveries);
    expect(result.isAdaptive).toBe(false);
  });

  it('fails open when Redis is null', async () => {
    const result = await checkWebhookRateLimit('merchant-1', cfg, null as any);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(cfg.maxDeliveries);
    expect(result.isAdaptive).toBe(false);
  });

  it('fails open when Redis throws an error', async () => {
    const redis = buildRedisMock();
    redis.zRemRangeByScore = async () => { throw new Error('Redis connection reset'); };

    const result = await checkWebhookRateLimit('merchant-1', cfg, redis as any);

    expect(result.allowed).toBe(true);
    expect(result.isAdaptive).toBe(false);
  });

  it('different merchants are isolated (per-merchant key space)', async () => {
    const redis = buildRedisMock();

    // Fill up merchant-A's limit
    for (let i = 0; i < 3; i++) {
      await checkWebhookRateLimit('merchant-A', cfg, redis as any);
    }
    const blockedA = await checkWebhookRateLimit('merchant-A', cfg, redis as any);
    expect(blockedA.allowed).toBe(false);

    // merchant-B should still be completely open
    const openB = await checkWebhookRateLimit('merchant-B', cfg, redis as any);
    expect(openB.allowed).toBe(true);
    expect(openB.remaining).toBe(2);
  });

  it('uses DEFAULT_RATE_LIMIT_CONFIG when no config is provided', async () => {
    const redis = buildRedisMock();
    // Just verify it runs without error and respects defaults
    const result = await checkWebhookRateLimit('merchant-default', undefined, redis as any);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxDeliveries - 1);
  });
});

// ---------------------------------------------------------------------------
// Tests — recordWebhookFailure
// ---------------------------------------------------------------------------

describe('recordWebhookFailure', () => {
  it('increments the failure counter on each call', async () => {
    const redis = buildRedisMock();

    await recordWebhookFailure('merchant-1', redis as any);
    expect(redis._strings.get('webhook:failures:merchant-1')).toBe('1');

    await recordWebhookFailure('merchant-1', redis as any);
    expect(redis._strings.get('webhook:failures:merchant-1')).toBe('2');
  });

  it('sets an expiry on the failure key', async () => {
    const redis = buildRedisMock();
    const expireSpy = jest.spyOn(redis, 'expire');

    await recordWebhookFailure('merchant-1', redis as any);

    expect(expireSpy).toHaveBeenCalledWith('webhook:failures:merchant-1', 3600);
  });

  it('is a no-op when Redis is unavailable', async () => {
    const redis = buildRedisMock();
    redis.isOpen = false;

    await recordWebhookFailure('merchant-1', redis as any);

    expect(redis._strings.has('webhook:failures:merchant-1')).toBe(false);
  });

  it('is a no-op when Redis is null', async () => {
    // Should not throw
    await expect(recordWebhookFailure('merchant-1', null as any)).resolves.toBeUndefined();
  });

  it('does not throw when Redis incr fails', async () => {
    const redis = buildRedisMock();
    redis.incr = async () => { throw new Error('ECONNREFUSED'); };

    await expect(recordWebhookFailure('merchant-1', redis as any)).resolves.toBeUndefined();
  });

  it('isolates failure counts per merchant', async () => {
    const redis = buildRedisMock();

    await recordWebhookFailure('merchant-A', redis as any);
    await recordWebhookFailure('merchant-A', redis as any);
    await recordWebhookFailure('merchant-B', redis as any);

    expect(redis._strings.get('webhook:failures:merchant-A')).toBe('2');
    expect(redis._strings.get('webhook:failures:merchant-B')).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Tests — recordWebhookSuccess
// ---------------------------------------------------------------------------

describe('recordWebhookSuccess', () => {
  it('deletes the failure counter key', async () => {
    const redis = buildRedisMock();
    redis._strings.set('webhook:failures:merchant-1', '3');

    await recordWebhookSuccess('merchant-1', redis as any);

    expect(redis._strings.has('webhook:failures:merchant-1')).toBe(false);
  });

  it('does not throw when the key does not exist', async () => {
    const redis = buildRedisMock();

    await expect(recordWebhookSuccess('merchant-1', redis as any)).resolves.toBeUndefined();
  });

  it('is a no-op when Redis is unavailable', async () => {
    const redis = buildRedisMock();
    redis.isOpen = false;
    redis._strings.set('webhook:failures:merchant-1', '3');

    await recordWebhookSuccess('merchant-1', redis as any);

    // Key should remain untouched
    expect(redis._strings.get('webhook:failures:merchant-1')).toBe('3');
  });

  it('is a no-op when Redis is null', async () => {
    await expect(recordWebhookSuccess('merchant-1', null as any)).resolves.toBeUndefined();
  });

  it('does not throw when Redis del fails', async () => {
    const redis = buildRedisMock();
    redis.del = async () => { throw new Error('ECONNREFUSED'); };

    await expect(recordWebhookSuccess('merchant-1', redis as any)).resolves.toBeUndefined();
  });

  it('resets adaptive penalty so subsequent checks are no longer adaptive', async () => {
    const redis = buildRedisMock();
    const cfg: RateLimitConfig = {
      maxDeliveries: 4,
      windowSecs: 60,
      failureThreshold: 2,
      adaptiveMultiplier: 0.5,
    };

    // Prime: 2 failures → isAdaptive
    redis._strings.set('webhook:failures:merchant-1', '2');
    const before = await checkWebhookRateLimit('merchant-1', cfg, redis as any);
    expect(before.isAdaptive).toBe(true);

    // Success resets failures
    await recordWebhookSuccess('merchant-1', redis as any);

    // Clear the sliding window for a clean check
    redis._sortedSets.delete('webhook:ratelimit:merchant-1');

    const after = await checkWebhookRateLimit('merchant-1', cfg, redis as any);
    expect(after.isAdaptive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — getWebhookDeliveryStatus
// ---------------------------------------------------------------------------

describe('getWebhookDeliveryStatus', () => {
  const cfg: RateLimitConfig = {
    maxDeliveries: 10,
    windowSecs: 60,
    failureThreshold: 3,
    adaptiveMultiplier: 0.5,
  };

  it('returns correct status for a merchant with no activity', async () => {
    const redis = buildRedisMock();
    const status = await getWebhookDeliveryStatus('merchant-1', cfg, redis as any);

    expect(status.deliveriesInWindow).toBe(0);
    expect(status.failureCount).toBe(0);
    expect(status.isAdaptive).toBe(false);
    expect(status.effectiveLimit).toBe(10);
  });

  it('reflects deliveries recorded by checkWebhookRateLimit', async () => {
    const redis = buildRedisMock();

    await checkWebhookRateLimit('merchant-1', cfg, redis as any);
    await checkWebhookRateLimit('merchant-1', cfg, redis as any);

    const status = await getWebhookDeliveryStatus('merchant-1', cfg, redis as any);
    expect(status.deliveriesInWindow).toBe(2);
  });

  it('reflects failure count recorded by recordWebhookFailure', async () => {
    const redis = buildRedisMock();

    await recordWebhookFailure('merchant-1', redis as any);
    await recordWebhookFailure('merchant-1', redis as any);
    await recordWebhookFailure('merchant-1', redis as any);

    const status = await getWebhookDeliveryStatus('merchant-1', cfg, redis as any);
    expect(status.failureCount).toBe(3);
    expect(status.isAdaptive).toBe(true);
    expect(status.effectiveLimit).toBe(5); // floor(10 * 0.5)
  });

  it('reports non-adaptive status before failure threshold', async () => {
    const redis = buildRedisMock();

    // 2 failures < threshold of 3
    await recordWebhookFailure('merchant-1', redis as any);
    await recordWebhookFailure('merchant-1', redis as any);

    const status = await getWebhookDeliveryStatus('merchant-1', cfg, redis as any);
    expect(status.failureCount).toBe(2);
    expect(status.isAdaptive).toBe(false);
    expect(status.effectiveLimit).toBe(10);
  });

  it('returns safe defaults when Redis is unavailable', async () => {
    const redis = buildRedisMock();
    redis.isOpen = false;

    const status = await getWebhookDeliveryStatus('merchant-1', cfg, redis as any);
    expect(status.deliveriesInWindow).toBe(0);
    expect(status.failureCount).toBe(0);
    expect(status.isAdaptive).toBe(false);
    expect(status.effectiveLimit).toBe(cfg.maxDeliveries);
  });

  it('returns safe defaults when Redis is null', async () => {
    const status = await getWebhookDeliveryStatus('merchant-1', cfg, null as any);
    expect(status.deliveriesInWindow).toBe(0);
    expect(status.failureCount).toBe(0);
    expect(status.isAdaptive).toBe(false);
    expect(status.effectiveLimit).toBe(cfg.maxDeliveries);
  });

  it('returns safe defaults when Redis throws', async () => {
    const redis = buildRedisMock();
    redis.zCard = async () => { throw new Error('Unexpected error'); };

    const status = await getWebhookDeliveryStatus('merchant-1', cfg, redis as any);
    expect(status.deliveriesInWindow).toBe(0);
    expect(status.isAdaptive).toBe(false);
  });

  it('uses DEFAULT_RATE_LIMIT_CONFIG when no config is supplied', async () => {
    const redis = buildRedisMock();
    const status = await getWebhookDeliveryStatus('merchant-default', undefined, redis as any);
    expect(status.effectiveLimit).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxDeliveries);
  });

  it('isolates status between merchants', async () => {
    const redis = buildRedisMock();

    await checkWebhookRateLimit('merchant-X', cfg, redis as any);
    await checkWebhookRateLimit('merchant-X', cfg, redis as any);
    await recordWebhookFailure('merchant-X', redis as any);
    await recordWebhookFailure('merchant-X', redis as any);
    await recordWebhookFailure('merchant-X', redis as any);

    const statusX = await getWebhookDeliveryStatus('merchant-X', cfg, redis as any);
    const statusY = await getWebhookDeliveryStatus('merchant-Y', cfg, redis as any);

    expect(statusX.deliveriesInWindow).toBe(2);
    expect(statusX.failureCount).toBe(3);
    expect(statusX.isAdaptive).toBe(true);

    expect(statusY.deliveriesInWindow).toBe(0);
    expect(statusY.failureCount).toBe(0);
    expect(statusY.isAdaptive).toBe(false);
  });
});
