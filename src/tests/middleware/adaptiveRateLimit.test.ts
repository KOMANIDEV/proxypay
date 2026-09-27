import {
  backoff,
  recover,
  getCurrentRps,
  recordProviderResponse,
  createAdaptiveRateLimitMiddleware,
} from "../../middleware/adaptiveRateLimit";

jest.mock("../../config/redis", () => ({
  redisClient: {
    hGetAll: jest.fn().mockResolvedValue({}),
    hSet: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock("../../utils/metrics", () => ({
  adaptiveRateLimitAdjustmentsTotal: { inc: jest.fn() },
  adaptiveRateLimitCurrentCapacity: { set: jest.fn() },
  rateLimitViolationsTotal: { inc: jest.fn() },
}));

import { redisClient } from "../../config/redis";
import {
  adaptiveRateLimitAdjustmentsTotal,
  adaptiveRateLimitCurrentCapacity,
  rateLimitViolationsTotal,
} from "../../utils/metrics";

beforeEach(() => {
  jest.clearAllMocks();
  (redisClient.hGetAll as jest.Mock).mockResolvedValue({});
  process.env.ADAPTIVE_RATE_LIMIT_DEFAULT_RPS = "10";
  process.env.ADAPTIVE_RATE_LIMIT_MIN_RPS = "1";
  process.env.ADAPTIVE_RATE_LIMIT_MAX_RPS = "100";
  process.env.ADAPTIVE_RATE_LIMIT_BACKOFF_FACTOR = "0.5";
  process.env.ADAPTIVE_RATE_LIMIT_RECOVERY_FACTOR = "1.1";
});

describe("adaptiveRateLimit - backoff", () => {
  it("reduces RPS on backoff", async () => {
    const newRps = await backoff("mtn", { provider: "mtn" } as any);
    expect(newRps).toBe(5); // 10 * 0.5
    expect(adaptiveRateLimitAdjustmentsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      direction: "backoff",
    });
  });

  it("does not reduce below minRps", async () => {
    // Set very low default
    process.env.ADAPTIVE_RATE_LIMIT_DEFAULT_RPS = "1";
    const newRps = await backoff("mtn", { provider: "mtn" } as any);
    expect(newRps).toBeGreaterThanOrEqual(1);
  });

  it("tracks consecutive failures", async () => {
    await backoff("mtn", { provider: "mtn" } as any);
    await backoff("mtn", { provider: "mtn" } as any);

    // Second call should halve again: 10 -> 5 -> 2.5
    const newRps = await backoff("mtn", { provider: "mtn" } as any);
    expect(newRps).toBeLessThan(5);
  });
});

describe("adaptiveRateLimit - recover", () => {
  it("increases RPS on recovery", async () => {
    const newRps = await recover("mtn", { provider: "mtn" } as any);
    expect(newRps).toBe(11); // 10 * 1.1
    expect(adaptiveRateLimitAdjustmentsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      direction: "recovery",
    });
  });

  it("does not exceed maxRps", async () => {
    process.env.ADAPTIVE_RATE_LIMIT_MAX_RPS = "12";
    process.env.ADAPTIVE_RATE_LIMIT_DEFAULT_RPS = "11";
    const newRps = await recover("mtn", { provider: "mtn" } as any);
    expect(newRps).toBeLessThanOrEqual(12);
  });
});

describe("adaptiveRateLimit - getCurrentRps", () => {
  it("returns default RPS when no state exists", async () => {
    const rps = await getCurrentRps("mtn");
    expect(rps).toBe(10);
  });

  it("returns stored RPS after adjustment", async () => {
    await backoff("mtn", { provider: "mtn" } as any);
    const rps = await getCurrentRps("mtn");
    expect(rps).toBe(5);
  });
});

describe("adaptiveRateLimit - recordProviderResponse", () => {
  it("backs off on 429 status", async () => {
    await recordProviderResponse("mtn", 429, {}, { provider: "mtn" } as any);
    expect(rateLimitViolationsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      status_code: "429",
    });
  });

  it("parses Retry-After header", async () => {
    await recordProviderResponse(
      "mtn",
      429,
      { "retry-after": "10" },
      { provider: "mtn" } as any,
    );
    // Should calculate a safe RPS
    const rps = await getCurrentRps("mtn");
    expect(rps).toBeLessThanOrEqual(10);
  });

  it("backs off on 5xx errors", async () => {
    await recordProviderResponse("mtn", 503, {}, { provider: "mtn" } as any);
    expect(rateLimitViolationsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      status_code: "503",
    });
  });

  it("backs off when X-RateLimit-Remaining is very low", async () => {
    await recordProviderResponse(
      "mtn",
      200,
      { "x-ratelimit-remaining": "1" },
      { provider: "mtn" } as any,
    );
    const rps = await getCurrentRps("mtn");
    expect(rps).toBeLessThan(10);
  });

  it("recovers on successful response", async () => {
    // First back off
    await backoff("mtn", { provider: "mtn" } as any);
    const afterBackoff = await getCurrentRps("mtn");
    expect(afterBackoff).toBe(5);

    // Then succeed
    await recordProviderResponse("mtn", 200, {}, { provider: "mtn" } as any);
    const afterRecover = await getCurrentRps("mtn");
    expect(afterRecover).toBeGreaterThan(5);
  });
});

describe("adaptiveRateLimit - middleware", () => {
  let req: any;
  let res: any;
  let next: jest.Mock;

  beforeEach(() => {
    req = { path: "/test", method: "GET", ip: "127.0.0.1" };
    res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it("allows request when tokens available", async () => {
    const middleware = createAdaptiveRateLimitMiddleware("mtn");
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", expect.any(Number));
  });

  it("rejects request when no tokens available", async () => {
    process.env.ADAPTIVE_RATE_LIMIT_DEFAULT_RPS = "0";
    const middleware = createAdaptiveRateLimitMiddleware("mtn");

    // First request consumes the token
    await middleware(req, res, next);
    jest.clearAllMocks();

    // Second request should be rejected
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Too Many Requests" }),
    );
  });
});
