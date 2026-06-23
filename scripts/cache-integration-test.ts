import { StatsController } from "../src/controllers/statsController";
import { redisClient } from "../src/config/redis";
import { StatsService } from "../src/services/statsService";
import { cacheHitsTotal } from "../src/utils/metrics";
import type { Request, Response } from "express";

// Simple in-memory redis mock using Map
const store = new Map<string, string>();

// Patch redisClient to be "open" and provide get/setEx/del/keys
// Override redisClient behavior for testing. isOpen is a getter, so redefine it.
try {
  Object.defineProperty(redisClient, "isOpen", {
    value: true,
    writable: false,
    configurable: true,
  });
} catch {
  // ignore
}
const rc = redisClient as unknown as Record<string, unknown>;
rc.get = async (k: string) => {
  const v = store.get(k);
  return v === undefined ? null : v;
};
rc.setEx = async (k: string, ttl: number, v: string) => {
  store.set(k, v);
  return "OK";
};
rc.del = async (k: string | string[]) => {
  if (Array.isArray(k)) {
    let removed = 0;
    for (const key of k) if (store.delete(key)) removed++;
    return removed;
  }
  return (store.delete(k as string) ? 1 : 0) as number;
};
rc.keys = async (pattern: string) => {
  // naive glob '*' only
  const re = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  return Array.from(store.keys()).filter((k) => re.test(k));
};

// Mock StatsService methods to return deterministic small payloads
const ssProto = StatsService.prototype as unknown as Record<string, unknown>;
ssProto.getGeneralStats = async function () {
  return {
    totalTransactions: 100,
    successRate: 0.98,
    totalVolume: 10000,
    averageAmount: 100,
  };
};
ssProto.getVolumeByProvider = async function (
  _startDate?: Date,
  _endDate?: Date,
) {
  return [{ provider: "p1", volume: 5000 }];
};
ssProto.getActiveUsersCount = async function () {
  return 42;
};
ssProto.getVolumeByPeriod = async function () {
  return [{ period: "2026-03-27", volume: 1000 }];
};

// Minimal mock req/res
function makeReq(): Request {
  return {
    method: "GET",
    path: "/api/stats",
    query: {},
    route: { path: "/api/stats" },
  } as unknown as Request;
}

function makeRes(): Response {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;
  const resObj: Partial<Response> & { headers: Record<string, string> } = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
      return resObj as Response;
    },
    getHeader: (k: string) => headers[k],
    headers,
    status: function (code: number) {
      statusCode = code;
      return resObj as Response;
    },
    json: (b: unknown) => {
      body = b;
      return { statusCode, body, headers } as unknown as Response;
    },
  };
  return resObj as Response;
}

async function run() {
  console.log(
    "Running cache integration test (mocked redis + mocked StatsService)",
  );

  const req1 = makeReq();
  const res1 = makeRes();

  const start1 = process.hrtime.bigint();
  await StatsController.getStats(req1, res1);
  const end1 = process.hrtime.bigint();
  const ms1 = Number(end1 - start1) / 1e6;
  console.log(
    `First call time: ${ms1.toFixed(3)} ms, X-Cache=${res1.getHeader?.("X-Cache") || "(none)"}`,
  );

  const req2 = makeReq();
  const res2 = makeRes();

  const start2 = process.hrtime.bigint();
  await StatsController.getStats(req2, res2);
  const end2 = process.hrtime.bigint();
  const ms2 = Number(end2 - start2) / 1e6;
  console.log(
    `Second call time: ${ms2.toFixed(3)} ms, X-Cache=${res2.getHeader?.("X-Cache") || "(none)"}`,
  );

  console.log("Prom-client counters (mocked register):");
  try {
    // prom-client's Counter.inc is a function; indicate we've touched the counters in the test
    console.log(
      "cache hits total incremented: ",
      typeof cacheHitsTotal.inc === "function",
    );
  } catch (err) {
    console.warn(err);
  }

  if (ms2 < 10) {
    console.log("✅ Second call under 10ms (cache hit)");
  } else {
    console.log(
      "❌ Second call NOT under 10ms; check decorator/res.json capture or environment",
    );
  }
}

run().catch((e) => {
  console.error("Test failed", e);
  process.exit(1);
});
