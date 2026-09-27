import express, { Request, Response } from "express";
import request from "supertest";
import { slidingWindowRateLimit } from "../slidingWindowRateLimit";

// ---------------------------------------------------------------------------
// Mock Redis so tests run without a real Redis connection
// ---------------------------------------------------------------------------

let buckets: Map<string, number[]>;

jest.mock("../../config/redis", () => ({
  redisClient: {
    get isOpen() { return true; },
    sendCommand: jest.fn(async (args: string[]) => {
      // args: ["EVAL", script, "1", key, now, windowStart, max, member, ttl]
      const key         = args[3];
      const now         = Number(args[4]);
      const windowStart = Number(args[5]);
      const maxReqs     = Number(args[6]);

      if (!buckets.has(key)) buckets.set(key, []);
      const entries = buckets.get(key)!;

      // Remove stale entries
      const fresh = entries.filter((ts) => ts > windowStart);
      buckets.set(key, fresh);

      if (fresh.length >= maxReqs) {
        const oldest = fresh[0] ?? now;
        return [0, fresh.length, oldest];
      }

      fresh.push(now);
      return [1, fresh.length, fresh[0] ?? now];
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(group: Parameters<typeof slidingWindowRateLimit>[0]) {
  const app = express();
  app.use(slidingWindowRateLimit(group));
  app.get("/", (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  buckets = new Map();
  jest.clearAllMocks();
});

describe("slidingWindowRateLimit – auth group (max=5)", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    // Override NODE_ENV so config resolves to production defaults (max=5)
    process.env.NODE_ENV = "production";
    app = makeApp("auth");
  });

  it("allows requests below the limit", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
    }
  });

  it("blocks the (max+1)th request with 429", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).get("/");
    }
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too Many Requests");
  });

  it("returns X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers", async () => {
    const res = await request(app).get("/");
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("decrements X-RateLimit-Remaining on each request", async () => {
    const first  = await request(app).get("/");
    const second = await request(app).get("/");
    const remFirst  = Number(first.headers["x-ratelimit-remaining"]);
    const remSecond = Number(second.headers["x-ratelimit-remaining"]);
    expect(remSecond).toBeLessThan(remFirst);
  });

  it("sets Retry-After on 429 response", async () => {
    for (let i = 0; i < 5; i++) await request(app).get("/");
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("uses x-api-key header as identifier (different keys have independent limits)", async () => {
    // Fill limit for key1
    for (let i = 0; i < 5; i++) {
      await request(app).get("/").set("x-api-key", "key1");
    }
    // key1 is blocked
    const blocked = await request(app).get("/").set("x-api-key", "key1");
    expect(blocked.status).toBe(429);

    // key2 should still be allowed
    const allowed = await request(app).get("/").set("x-api-key", "key2");
    expect(allowed.status).toBe(200);
  });

  it("falls back to IP when no API key is present", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).get("/");
    }
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
  });
});

describe("slidingWindowRateLimit – payment group (max=60)", () => {
  it("allows 60 requests", async () => {
    process.env.NODE_ENV = "production";
    const app = makeApp("payment");
    for (let i = 0; i < 60; i++) {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
    }
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
  });
});

describe("slidingWindowRateLimit – readonly group (max=300)", () => {
  it("allows 300 requests and blocks the 301st", async () => {
    process.env.NODE_ENV = "production";
    const app = makeApp("readonly");
    for (let i = 0; i < 300; i++) {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
    }
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
  });
});

describe("slidingWindowRateLimit – Redis unavailable", () => {
  it("fails open and passes the request through", async () => {
    // Access the already-mocked module via jest.requireMock
    const { redisClient } = jest.requireMock("../../config/redis") as { redisClient: any };
    const original = redisClient.isOpen;
    Object.defineProperty(redisClient, "isOpen", { get: () => false, configurable: true });

    process.env.NODE_ENV = "production";
    const app = makeApp("auth");
    const res = await request(app).get("/");
    expect(res.status).toBe(200);

    // Restore
    Object.defineProperty(redisClient, "isOpen", { get: () => original, configurable: true });
  });
});
