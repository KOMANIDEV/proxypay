jest.mock("../../src/config/redis", () => ({
  redisClient: {
    isOpen: true,
    incr: jest.fn(),
    pexpire: jest.fn(),
    sendCommand: jest.fn(),
  },
}));

import { redisClient } from "../../src/config/redis";
import {
  createEndpointRateLimiter,
  normaliseProvider,
  normaliseTier,
  RATE_LIMIT_CONFIG,
  resolveEndpointRateLimit,
  validateRateLimitConfig,
} from "../../src/middleware/rateLimit";

const mockRedis = redisClient as unknown as {
  isOpen: boolean;
  incr: jest.Mock;
  pexpire: jest.Mock;
};

function createRes() {
  const res: any = {
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  res.setHeader.mockReturnValue(res);
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function createReq(overrides: Record<string, unknown> = {}) {
  return {
    ip: "127.0.0.1",
    params: {},
    query: {},
    body: {},
    headers: {},
    path: "/api/transactions",
    method: "POST",
    ...overrides,
  } as any;
}

describe("per-endpoint rate limiting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.isOpen = true;
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.pexpire.mockResolvedValue(1);
  });

  describe("configuration validation", () => {
    it("accepts the default endpoint table", () => {
      expect(validateRateLimitConfig()).toEqual({ valid: true, errors: [] });
    });

    it("rejects malformed endpoints, windows and overrides", () => {
      const result = validateRateLimitConfig({
        transactions: { limit: 0, windowMs: 10 },
        "POST /api/transactions": {
          limit: 10,
          windowMs: 60 * 1000,
          keyBy: "account" as any,
          providerOverrides: { wave: { limit: 1, windowMs: 1000 } } as any,
          tierOverrides: { gold: { limit: 1, windowMs: 1000 } } as any,
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toContain('expected "<METHOD> <path>"');
      expect(result.errors.join(" ")).toContain("keyBy");
      expect(result.errors.join(" ")).toContain("wave");
      expect(result.errors.join(" ")).toContain("gold");
      expect(result.errors.join(" ")).toContain("windowMs");
    });
  });

  describe("resolveEndpointRateLimit", () => {
    it("returns the endpoint default when no override applies", () => {
      const resolved = resolveEndpointRateLimit("POST /api/transactions", {
        provider: "default",
        tier: "standard",
      });

      expect(resolved.limit).toBe(60);
      expect(resolved.source).toBe("endpoint");
      expect(resolved.keyBy).toBe("user");
    });

    it("applies provider overrides for MTN, Airtel and Orange", () => {
      expect(
        resolveEndpointRateLimit("POST /api/transactions", { provider: "mtn" })
          .limit,
      ).toBe(80);
      expect(
        resolveEndpointRateLimit("POST /api/transactions", {
          provider: "airtel",
        }).limit,
      ).toBe(50);
      expect(
        resolveEndpointRateLimit("POST /api/transactions", {
          provider: "orange",
        }).limit,
      ).toBe(40);
    });

    it("gives tier overrides precedence over provider overrides", () => {
      const resolved = resolveEndpointRateLimit("POST /api/transactions", {
        provider: "orange",
        tier: "vip",
      });

      expect(resolved.limit).toBe(300);
      expect(resolved.source).toBe("tier-override");
    });

    it("falls back to the global limit for unknown endpoints", () => {
      const resolved = resolveEndpointRateLimit("GET /api/unknown");

      expect(resolved.limit).toBe(RATE_LIMIT_CONFIG.GLOBAL_LIMIT);
      expect(resolved.windowMs).toBe(RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS);
      expect(resolved.source).toBe("global-default");
    });
  });

  describe("provider / tier normalisation", () => {
    it("maps provider aliases onto the supported names", () => {
      expect(normaliseProvider("MTN MoMo")).toBe("mtn");
      expect(normaliseProvider("mtn_momo")).toBe("mtn");
      expect(normaliseProvider("Airtel Money")).toBe("airtel");
      expect(normaliseProvider("Orange Money")).toBe("orange");
      expect(normaliseProvider("wave")).toBe("default");
      expect(normaliseProvider(undefined)).toBe("default");
    });

    it("treats vip and premium users as the vip audience", () => {
      expect(normaliseTier("VIP")).toBe("vip");
      expect(normaliseTier("premium")).toBe("vip");
      expect(normaliseTier("pro")).toBe("standard");
      expect(normaliseTier(undefined)).toBe("standard");
    });
  });

  describe("createEndpointRateLimiter", () => {
    it("allows requests under the limit and sets rate limit headers", async () => {
      const limiter = createEndpointRateLimiter("POST /api/transactions");
      const req = createReq({ body: { provider: "mtn" }, user: { id: "u1" } });
      const res = createRes();
      const next = jest.fn();

      await limiter(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 80);
      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 79);
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Policy",
        "80;w=60",
      );
      expect(mockRedis.incr).toHaveBeenCalledWith(
        expect.stringContaining(
          "ratelimit:endpoint:POST /api/transactions:mtn:standard:u1",
        ),
      );
    });

    it("rejects requests that exceed the endpoint limit", async () => {
      mockRedis.incr.mockResolvedValue(61);
      const limiter = createEndpointRateLimiter("POST /api/transactions");
      const req = createReq({ user: { id: "u1" } });
      const res = createRes();
      const next = jest.fn();

      await limiter(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.setHeader).toHaveBeenCalledWith(
        "Retry-After",
        expect.any(String),
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Rate limit exceeded",
          endpoint: "POST /api/transactions",
          limit: 60,
          provider: "default",
          tier: "standard",
        }),
      );
    });

    it("raises the limit for VIP users", async () => {
      const limiter = createEndpointRateLimiter("GET /api/transactions");
      const req = createReq({
        method: "GET",
        path: "/api/transactions",
        user: { id: "vip-1", tier: "vip" },
      });
      const res = createRes();

      await limiter(req, res, jest.fn());

      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 600);
      expect(mockRedis.incr).toHaveBeenCalledWith(
        expect.stringContaining(":vip:vip-1"),
      );
    });

    it("uses the global limit for endpoints without a specific configuration", async () => {
      const limiter = createEndpointRateLimiter("GET /api/unknown");
      const req = createReq({ method: "GET", path: "/api/unknown" });
      const res = createRes();
      const next = jest.fn();

      await limiter(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Limit",
        RATE_LIMIT_CONFIG.GLOBAL_LIMIT,
      );
    });
  });
});
