import {
  normalizeHeaders,
  getHeader,
  parseCount,
  parseReset,
  parseRetryAfter,
  parseWindowSeconds,
  resolveHeaderMap,
  parseProviderRateLimitHeaders,
  trackProviderRateLimit,
  getProviderRateLimit,
  decideThrottle,
  _resetProviderRateLimitState,
  PROVIDER_RATE_LIMIT_HEADER_MAPS,
  DEFAULT_HEADER_MAP,
} from "../../middleware/providerRateLimitHeaders";

jest.mock("../../config/redis", () => ({
  redisClient: {
    hGetAll: jest.fn().mockResolvedValue({}),
    hSet: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock("../../utils/metrics", () => ({
  providerRateLimitState: { set: jest.fn() },
  providerRateLimitHitsTotal: { inc: jest.fn() },
}));

import { redisClient } from "../../config/redis";
import {
  providerRateLimitState,
  providerRateLimitHitsTotal,
} from "../../utils/metrics";

const NOW = 1_700_000_000_000;

const baseConfig = { provider: "mtn" };

beforeEach(() => {
  jest.clearAllMocks();
  _resetProviderRateLimitState();
  (redisClient.hGetAll as jest.Mock).mockResolvedValue({});
});

describe("normalizeHeaders", () => {
  it("folds header names to lower case", () => {
    expect(
      normalizeHeaders({ "X-RateLimit-Limit": "100", "Content-Type": "json" }),
    ).toEqual({ "x-ratelimit-limit": "100", "content-type": "json" });
  });

  it("stringifies numbers and keeps only the last multi-value", () => {
    expect(
      normalizeHeaders({ "x-ratelimit-reset": [1700001000, 1700002000] }),
    ).toEqual({ "x-ratelimit-reset": "1700002000" });
  });

  it("skips undefined values", () => {
    expect(
      normalizeHeaders({ "x-ratelimit-limit": undefined, "x-ratelimit-remaining": "5" }),
    ).toEqual({ "x-ratelimit-remaining": "5" });
  });
});

describe("getHeader", () => {
  it("resolves case-insensitively", () => {
    const headers = { "x-ratelimit-limit": "10" };
    expect(getHeader(headers, "X-RateLimit-Limit")).toBe("10");
  });
});

describe("parseCount", () => {
  it("parses positive integers", () => {
    expect(parseCount("100")).toBe(100);
    expect(parseCount("0")).toBe(0);
  });

  it("handles decimals used by some providers", () => {
    expect(parseCount("4.5")).toBe(4.5);
  });

  it("returns null for invalid values", () => {
    expect(parseCount(undefined)).toBeNull();
    expect(parseCount("abc")).toBeNull();
    expect(parseCount("-5")).toBeNull();
    expect(parseCount("")).toBeNull();
  });
});

describe("parseReset", () => {
  it("parses epoch seconds (10 digits)", () => {
    const epochSecs = Math.floor(NOW / 1000) + 60;
    const ms = parseReset(String(epochSecs), NOW);
    expect(ms).toBe(epochSecs * 1000);
  });

  it("parses epoch milliseconds (13 digits)", () => {
    const ms = NOW + 60_000;
    expect(parseReset(String(ms), NOW)).toBe(ms);
  });

  it("parses delta seconds (<= 6 digits) as a countdown", () => {
    expect(parseReset("30", NOW)).toBe(NOW + 30_000);
  });

  it("parses HTTP-date", () => {
    const future = new Date(NOW + 120_000);
    const dateStr = future.toUTCString();
    expect(parseReset(dateStr, NOW)).toBe(future.getTime());
  });

  it("returns null when the header is absent or unparseable", () => {
    expect(parseReset(undefined, NOW)).toBeNull();
    expect(parseReset("not-a-date", NOW)).toBeNull();
    expect(parseReset("", NOW)).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("parses a seconds value", () => {
    expect(parseRetryAfter("15", NOW)).toBe(15);
  });

  it("parses an HTTP-date into seconds until then", () => {
    const future = new Date(NOW + 5_000);
    expect(parseRetryAfter(future.toUTCString(), NOW)).toBe(5);
  });

  it("returns null for invalid values", () => {
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
    expect(parseRetryAfter("nope", NOW)).toBeNull();
    expect(parseRetryAfter("", NOW)).toBeNull();
  });
});

describe("parseWindowSeconds", () => {
  it("parses 'w=' policy", () => {
    expect(parseWindowSeconds("100;w=60")).toBe(60);
  });

  it("parses 'window=' form", () => {
    expect(parseWindowSeconds("5;window=3600")).toBe(3600);
  });

  it("treats a bare integer as the window length", () => {
    expect(parseWindowSeconds("60")).toBe(60);
  });

  it("returns null when unknown", () => {
    expect(parseWindowSeconds(undefined)).toBeNull();
    expect(parseWindowSeconds("")).toBeNull();
    expect(parseWindowSeconds("abc")).toBeNull();
  });
});

describe("resolveHeaderMap", () => {
  it("returns conventional names when a provider has no custom map", () => {
    expect(resolveHeaderMap({ provider: "mtn" })).toEqual(DEFAULT_HEADER_MAP);
  });

  it("allows overriding a name per-provider", () => {
    PROVIDER_RATE_LIMIT_HEADER_MAPS.orange = { remaining: "x-rem" };
    const map = resolveHeaderMap({ provider: "orange" });
    expect(map.remaining).toBe("x-rem");
    expect(map.limit).toBe(DEFAULT_HEADER_MAP.limit);
  });

  it("prefers per-config overrides over provider maps", () => {
    PROVIDER_RATE_LIMIT_HEADER_MAPS.orange = { remaining: "x-provider-rem" };
    const map = resolveHeaderMap({
      provider: "orange",
      headers: { remaining: "x-config-rem" },
    });
    expect(map.remaining).toBe("x-config-rem");
  });
});

describe("parseProviderRateLimitHeaders", () => {
  it("parses the full X-RateLimit-* family", () => {
    const quota = parseProviderRateLimitHeaders(
      { provider: "mtn" },
      {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "42",
        "x-ratelimit-reset": "30",
        "x-ratelimit-policy": "100;w=60",
        "retry-after": "3",
      },
      NOW,
    );

    expect(quota).toMatchObject({
      limit: 100,
      remaining: 42,
      remainingRaw: 42,
      resetAt: NOW + 30_000,
      windowSeconds: 60,
      retryAfterSeconds: 3,
      parsed: true,
    });
  });

  it("handles provider-specific header names", () => {
    const quota = parseProviderRateLimitHeaders(
      {
        provider: "mtn",
        headers: { reset: "x-reset-at", remaining: "x-remaining" },
      },
      { "x-remaining": "7", "x-reset-at": "10" },
      NOW,
    );

    expect(quota).toMatchObject({
      remaining: 7,
      resetAt: NOW + 10_000,
      parsed: true,
    });
  });

  it("returns parsed=false when nothing is recognised", () => {
    const quota = parseProviderRateLimitHeaders(
      baseConfig,
      { "content-type": "json" },
      NOW,
    );
    expect(quota.parsed).toBe(false);
    expect(quota.limit).toBeNull();
    expect(quota.remaining).toBeNull();
    expect(quota.resetAt).toBeNull();
  });

  it("infers resetAt from Retry-After when no reset header exists", () => {
    const quota = parseProviderRateLimitHeaders(
      baseConfig,
      { "retry-after": "5" },
      NOW,
    );
    expect(quota.resetAt).toBe(NOW + 5000);
  });

  it("rounds fractional remaining counts", () => {
    const quota = parseProviderRateLimitHeaders(
      baseConfig,
      { "x-ratelimit-remaining": "4.6" },
      NOW,
    );
    expect(quota.remaining).toBe(5);
    expect(quota.remainingRaw).toBe(4.6);
  });
});

describe("trackProviderRateLimit", () => {
  it("persists and returns the parsed quota", async () => {
    const quota = await trackProviderRateLimit(
      baseConfig,
      {
        "x-ratelimit-limit": "50",
        "x-ratelimit-remaining": "10",
        "x-ratelimit-reset": "60",
      },
      NOW,
    );

    expect(quota).toMatchObject({ limit: 50, remaining: 10, resetAt: NOW + 60_000 });
    expect(providerRateLimitState.set).toHaveBeenCalledWith(
      { provider: "mtn" },
      10,
    );
    expect(redisClient.hSet).toHaveBeenCalled();
  });

  it("does not persist when nothing is parsed", async () => {
    await trackProviderRateLimit(baseConfig, {}, NOW);
    expect(providerRateLimitState.set).not.toHaveBeenCalled();
    expect(redisClient.hSet).not.toHaveBeenCalled();
  });

  it("getProviderRateLimit reads back the tracked state", async () => {
    await trackProviderRateLimit(
      baseConfig,
      { "x-ratelimit-remaining": "8", "x-ratelimit-limit": "10" },
      NOW,
    );
    const state = await getProviderRateLimit("mtn");
    expect(state).toMatchObject({ provider: "mtn", remaining: 8, limit: 10 });
  });
});

describe("decideThrottle", () => {
  it("allows when no quota info is available", async () => {
    const decision = await decideThrottle(baseConfig, { now: NOW });
    expect(decision.allowed).toBe(true);
  });

  it("blocks on a positive Retry-After header", async () => {
    const decision = await decideThrottle(baseConfig, {
      headers: { "retry-after": "4" },
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(4000);
    expect(decision.reason).toBe("retry-after");
    expect(providerRateLimitHitsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      reason: "retry-after",
    });
  });

  it("blocks when quota is exhausted before the reset", async () => {
    const decision = await decideThrottle(
      { provider: "mtn", lowQuotaRatio: 0 },
      {
        lastQuota: {
          provider: "mtn",
          remaining: 0,
          limit: 10,
          resetAt: NOW + 100_000,
          updatedAt: NOW,
        },
        now: NOW,
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("exhausted");
  });

  it("allows when exhausted but the window is about to reset", async () => {
    const decision = await decideThrottle(baseConfig, {
      lastQuota: {
        provider: "mtn",
        remaining: 0,
        limit: 10,
        resetAt: NOW + 10, // within leeway
        updatedAt: NOW,
      },
      now: NOW,
    });
    expect(decision.allowed).toBe(true);
  });

  it("throttles proactively on low remaining quota (ratio-based)", async () => {
    const decision = await decideThrottle(
      { provider: "mtn", lowQuotaRatio: 0.2 },
      {
        lastQuota: {
          provider: "mtn",
          remaining: 1,
          limit: 10,
          resetAt: NOW + 30_000,
          updatedAt: NOW,
        },
        now: NOW,
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("low-quota");
    expect(decision.retryAfterMs).toBe(30_000);
  });

  it("uses absolute count when configured", async () => {
    const decision = await decideThrottle(
      { provider: "mtn", useAbsoluteCount: true, lowQuotaCount: 5 },
      {
        lastQuota: {
          provider: "mtn",
          remaining: 3,
          limit: 100,
          resetAt: NOW + 30_000,
          updatedAt: NOW,
        },
        now: NOW,
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("low-quota");
  });

  it("allows a low-quota request when near reset", async () => {
    const decision = await decideThrottle(baseConfig, {
      lastQuota: {
        provider: "mtn",
        remaining: 0,
        limit: 10,
        resetAt: NOW + 10,
        updatedAt: NOW,
      },
      now: NOW,
    });
    expect(decision.allowed).toBe(true);
  });

  it("falls back to persisted state when no lastQuota is passed", async () => {
    (redisClient.hGetAll as jest.Mock).mockResolvedValue({
      remaining: "0",
      limit: "10",
      resetAt: String(NOW + 100_000),
      updatedAt: String(NOW),
    });
    const decision = await decideThrottle(baseConfig, { now: NOW });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("exhausted");
  });
});
