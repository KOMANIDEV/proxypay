/**
 * #482 – Automatic Database Optimization
 *
 * The database calls are mocked so the optimisation logic (thresholds,
 * cooldowns, fingerprinting, plan regression detection) can be exercised
 * without a live PostgreSQL instance.
 */

import { DatabaseOptimizationService } from "../databaseOptimizationService";
import { pool, queryRead, queryWrite } from "../../config/database";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

const mockedPoolQuery = pool.query as jest.Mock;
const mockedQueryRead = queryRead as jest.Mock;
const mockedQueryWrite = queryWrite as jest.Mock;

function service(overrides: Partial<ConstructorParameters<typeof DatabaseOptimizationService>[0]> = {}) {
  return new DatabaseOptimizationService({
    minIndexSizeMb: 1,
    rebuildThresholdPct: 40,
    reindexCooldownHours: 24,
    planRegressionRatio: 1.5,
    vacuumTargets: ["transactions", "users"],
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("query fingerprinting", () => {
  it("collapses literals so equivalent statements share a cache entry", () => {
    const a = DatabaseOptimizationService.fingerprintQuery(
      "SELECT * FROM transactions WHERE user_id = 'abc' LIMIT 10",
    );
    const b = DatabaseOptimizationService.fingerprintQuery(
      "SELECT * FROM transactions WHERE user_id = 'xyz' LIMIT 25",
    );

    expect(a.hash).toBe(b.hash);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("produces different hashes for structurally different queries", () => {
    const a = DatabaseOptimizationService.fingerprintQuery(
      "SELECT id FROM transactions",
    );
    const b = DatabaseOptimizationService.fingerprintQuery(
      "SELECT reference_number FROM transactions",
    );

    expect(a.hash).not.toBe(b.hash);
  });

  it("strips comments before hashing", () => {
    const withComment = DatabaseOptimizationService.fingerprintQuery(
      "SELECT 1 -- nightly job\n",
    );
    const withoutComment = DatabaseOptimizationService.fingerprintQuery("SELECT 1");

    expect(withComment.hash).toBe(withoutComment.hash);
  });
});

describe("extractPlanCost", () => {
  it("reads a top-level Plan Cost", () => {
    expect(
      DatabaseOptimizationService.extractPlanCost({ "Plan Cost": 12.5 }),
    ).toBe(12.5);
  });

  it("reads a nested total_cost", () => {
    expect(
      DatabaseOptimizationService.extractPlanCost({ plan: { total_cost: 7 } }),
    ).toBe(7);
  });

  it("returns null for an unrecognised plan shape", () => {
    expect(DatabaseOptimizationService.extractPlanCost({})).toBeNull();
  });
});

describe("vacuumAndAnalyze", () => {
  it("runs VACUUM ANALYZE for each configured table", async () => {
    mockedPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await service().vacuumAndAnalyze(["transactions", "public.users"]);

    expect(mockedPoolQuery).toHaveBeenCalledTimes(2);
    expect(mockedPoolQuery.mock.calls[0][0]).toContain("VACUUM (ANALYZE");
    expect(result.map((r) => r.table)).toEqual(["transactions", "users"]);
  });

  it("skips tables that do not exist", async () => {
    mockedPoolQuery.mockRejectedValueOnce(
      Object.assign(new Error("relation does not exist"), { code: "42P01" }),
    );

    const result = await service().vacuumAndAnalyze(["missing_table", "users"]);

    expect(result.map((r) => r.table)).toEqual(["users"]);
  });

  it("does not abort the cycle on an unexpected failure", async () => {
    mockedPoolQuery
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ rows: [] });

    const result = await service().vacuumAndAnalyze(["locked_table", "users"]);

    expect(result.map((r) => r.table)).toEqual(["users"]);
  });

  it("quotes identifiers defensively", async () => {
    mockedPoolQuery.mockResolvedValue({ rows: [] });

    await service().vacuumAndAnalyze(['we"ird']);

    expect(mockedPoolQuery.mock.calls[0][0]).toContain('"we""ird"');
  });
});

describe("monitorIndexFragmentation", () => {
  it("flags indexes above the threshold and persists the sample", async () => {
    mockedQueryRead
      // index candidate list
      .mockResolvedValueOnce({
        rows: [
          { schemaname: "public", tablename: "tx", indexname: "idx_bad", size_bytes: "5000000" },
          { schemaname: "public", tablename: "tx", indexname: "idx_ok", size_bytes: "6000000" },
        ],
      })
      // leaf density for idx_bad
      .mockResolvedValueOnce({ rows: [{ avg_leaf_density: 50 }] })
      // leaf density for idx_ok
      .mockResolvedValueOnce({ rows: [{ avg_leaf_density: 95 }] });
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 1 });

    const samples = await service().monitorIndexFragmentation();

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      index: "idx_bad",
      fragmentationPct: 50,
      needsRebuild: true,
    });
    expect(samples[1]).toMatchObject({
      index: "idx_ok",
      fragmentationPct: 5,
      needsRebuild: false,
    });
    expect(mockedQueryWrite).toHaveBeenCalledTimes(2);
  });

  it("skips indexes whose density cannot be measured", async () => {
    mockedQueryRead
      .mockResolvedValueOnce({
        rows: [{ schemaname: "public", tablename: "tx", indexname: "idx_x", size_bytes: "10" }],
      })
      .mockResolvedValueOnce({ rows: [{ avg_leaf_density: null }] });

    const samples = await service().monitorIndexFragmentation();

    expect(samples).toEqual([]);
    expect(mockedQueryWrite).not.toHaveBeenCalled();
  });
});

describe("reorganizeIndexes", () => {
  it("rebuilds only the flagged indexes", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [{ recent: false }] });
    mockedPoolQuery.mockResolvedValue({ rows: [] });

    const { rebuilt, skipped } = await service().reorganizeIndexes([
      { schema: "public", table: "tx", index: "idx_bad", sizeBytes: 1, leafDensity: 40, fragmentationPct: 60, needsRebuild: true },
      { schema: "public", table: "tx", index: "idx_ok", sizeBytes: 1, leafDensity: 98, fragmentationPct: 2, needsRebuild: false },
    ]);

    expect(rebuilt).toEqual(["idx_bad"]);
    expect(skipped).toEqual([]);
    expect(mockedPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockedPoolQuery.mock.calls[0][0]).toContain("REINDEX INDEX CONCURRENTLY");
  });

  it("honours the rebuild cooldown", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [{ recent: true }] });

    const { rebuilt, skipped } = await service().reorganizeIndexes([
      { schema: "public", table: "tx", index: "idx_bad", sizeBytes: 1, leafDensity: 40, fragmentationPct: 60, needsRebuild: true },
    ]);

    expect(rebuilt).toEqual([]);
    expect(skipped).toEqual(["idx_bad"]);
    expect(mockedPoolQuery).not.toHaveBeenCalled();
  });

  it("treats a concurrent rebuild as a skip, not a failure", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [{ recent: false }] });
    mockedPoolQuery.mockRejectedValueOnce(
      Object.assign(new Error("cannot reindex relation"), { code: "55006" }),
    );

    const { rebuilt, skipped } = await service().reorganizeIndexes([
      { schema: "public", table: "tx", index: "idx_busy", sizeBytes: 1, leafDensity: 40, fragmentationPct: 60, needsRebuild: true },
    ]);

    expect(rebuilt).toEqual([]);
    expect(skipped).toEqual(["idx_busy"]);
  });
});

describe("query plan cache", () => {
  const planRow = {
    query_hash: "abc",
    query_fingerprint: "SELECT ...",
    plan: { "Plan Cost": 10 },
    plan_cost: 10,
    hit_count: 0,
    is_regression: false,
    last_used_at: new Date(),
  };

  it("caches a plan and increments the hit counter on read", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [] });
    mockedQueryWrite
      .mockResolvedValueOnce({ rows: [planRow] }) // insert
      .mockResolvedValueOnce({ rows: [{ ...planRow, hit_count: 1 }] }); // touch

    const svc = service();
    await svc.cacheQueryPlan("SELECT * FROM transactions WHERE id = '1'", { "Plan Cost": 10 });
    const hit = await svc.getCachedQueryPlan("SELECT * FROM transactions WHERE id = '2'");

    expect(hit?.hitCount).toBe(1);
  });

  it("flags a plan whose cost regressed beyond the tolerance", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [planRow] });
    mockedQueryWrite.mockResolvedValue({
      rows: [{ ...planRow, plan_cost: 20, is_regression: true }],
    });

    const verdict = await service().cacheQueryPlan(
      "SELECT * FROM transactions WHERE id = 1",
      { "Plan Cost": 20 },
    );

    expect(verdict.isRegression).toBe(true);
    expect(mockedQueryWrite.mock.calls[0][1][4]).toBe(true);
  });

  it("does not flag a marginal cost change", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [planRow] });
    mockedQueryWrite.mockResolvedValue({ rows: [{ ...planRow, plan_cost: 12 }] });

    const verdict = await service().cacheQueryPlan(
      "SELECT * FROM transactions WHERE id = 1",
      { "Plan Cost": 12 },
    );

    expect(verdict.isRegression).toBe(false);
  });

  it("derives the cost from the plan when not supplied", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [] });
    mockedQueryWrite.mockResolvedValue({ rows: [{ ...planRow, plan_cost: 42 }] });

    const verdict = await service().cacheQueryPlan("SELECT 1", { "Plan Cost": 42 });

    expect(verdict.planCost).toBe(42);
  });
});

describe("runOptimizationCycle", () => {
  it("records a successful run", async () => {
    mockedPoolQuery.mockResolvedValue({ rows: [] });
    mockedQueryRead
      // fragmentation candidates
      .mockResolvedValueOnce({ rows: [] })
      // cooldown check is not reached (no flagged indexes)
      // plan cache stats
      .mockResolvedValueOnce({
        rows: [{ total_entries: 4, regressions: 1, avg_hit_count: 2 }],
      });
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 0 });

    const report = await service().runOptimizationCycle();

    expect(report.vacuumAnalyzed).toBe(2);
    expect(report.fragmentedIndexes).toBe(0);
    expect(report.planCacheEntries).toBe(4);
  });

  it("records a failed run instead of throwing", async () => {
    mockedPoolQuery.mockRejectedValue(new Error("database is down"));
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 1 });

    const report = await service().runOptimizationCycle();

    expect(report.vacuumAnalyzed).toBe(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});
