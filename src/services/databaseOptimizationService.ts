/**
 * #482 – Automatic Database Optimization
 *
 * Database performance degrades over time: dead tuples accumulate, index leaf
 * pages fragment and the planner repeatedly re-plans identical query shapes.
 * This service automates the three remediation levers PostgreSQL exposes and
 * records enough telemetry to prove the automation is working.
 *
 *   1. `vacuumAndAnalyze()`  – drives autovacuum harder for the tables that
 *      receive the most churn and refreshs planner statistics so the
 *      statistics target is honoured.
 *   2. `monitorIndexFragmentation()` – samples leaf density per index
 *      (`pgstatindex`), converts it to a fragmentation percentage and flags
 *      any index above the rebuild threshold.
 *   3. `reorganizeIndexes()` – issues `REINDEX CONCURRENTLY` for the
 *      indexes flagged as fragmented, skipping anything that has already been
 *      rebuilt recently.
 *   4. `cacheQueryPlan()` / `getCachedQueryPlan()` – keeps an EXPLAIN plan
 *      cache keyed by a normalised query fingerprint and flags plan
 *      regressions when the cost drifts beyond a tolerance.
 *
 * Everything is best-effort: a maintenance cycle must never take the service
 * down because statistics collection failed.
 */

import { createHash } from "crypto";
import { pool, queryRead, queryWrite } from "../config/database";
import logger from "../utils/logger";

/** Tables that receive the highest write volume on the bridge hot path. */
export const DEFAULT_VACUUM_TARGETS = [
  "transactions",
  "users",
  "disputes",
  "fraud_alerts",
  "webhook_deliveries",
  "provider_webhook_events",
  "ledger_entries",
  "notifications",
] as const;

export interface VacuumTarget {
  schema: string;
  table: string;
  /** Rows removed by the last statistics pass – used for reporting. */
  deadTuples: number;
}

export interface FragmentationSample {
  schema: string;
  table: string;
  index: string;
  sizeBytes: number;
  /** `pgstatindex().avg_leaf_density` – 100 means perfectly packed. */
  leafDensity: number | null;
  /** 0–100, higher means more free space in the index. */
  fragmentationPct: number;
  needsRebuild: boolean;
}

export interface CachedQueryPlan {
  queryHash: string;
  fingerprint: string;
  plan: Record<string, unknown>;
  planCost: number | null;
  hitCount: number;
  isRegression: boolean;
  lastUsedAt: Date;
}

export interface OptimizationRunReport {
  vacuumAnalyzed: number;
  reindexed: number;
  fragmentedIndexes: number;
  planCacheEntries: number;
  durationMs: number;
}

export interface OptimizationConfig {
  /** Minimum index size (MB) before fragmentation is worth measuring. */
  minIndexSizeMb: number;
  /** Fragmentation percentage at which a REINDEX is issued. */
  rebuildThresholdPct: number;
  /** Skip an index that was rebuilt within this many hours. */
  reindexCooldownHours: number;
  /** Relative cost drift that marks a cached plan as a regression. */
  planRegressionRatio: number;
  /** Run VACUUM ANALYZE for these tables. */
  vacuumTargets: string[];
}

const DEFAULTS: OptimizationConfig = {
  minIndexSizeMb: Number(process.env.DB_OPTIMIZATION_MIN_INDEX_SIZE_MB ?? 1),
  rebuildThresholdPct: Number(
    process.env.DB_OPTIMIZATION_REBUILD_THRESHOLD_PCT ?? 40,
  ),
  reindexCooldownHours: Number(
    process.env.DB_OPTIMIZATION_REINDEX_COOLDOWN_HOURS ?? 24,
  ),
  planRegressionRatio: Number(
    process.env.DB_OPTIMIZATION_PLAN_REGRESSION_RATIO ?? 1.5,
  ),
  vacuumTargets: [...DEFAULT_VACUUM_TARGETS],
};

/** Quote an identifier for safe interpolation into DDL (never from user input). */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function isRelationMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "42704";
}

function isIndexInUse(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // 55006 = object_in_use, 42P07 = duplicate_table
  return code === "55006" || code === "42P07";
}

export class DatabaseOptimizationService {
  constructor(private readonly config: OptimizationConfig = DEFAULTS) {}

  // -------------------------------------------------------------------------
  // 1. Automatic VACUUM / ANALYZE
  // -------------------------------------------------------------------------

  /**
   * Run `VACUUM (ANALYZE)` for every configured table that actually exists in
   * the database. VACUUM cannot run inside a transaction block, so this uses
   * `pool.query` directly rather than a client-scoped transaction.
   */
  async vacuumAndAnalyze(
    tables: string[] = this.config.vacuumTargets,
  ): Promise<VacuumTarget[]> {
    const processed: VacuumTarget[] = [];

    for (const table of tables) {
      const [schema, bareTable] = table.includes(".")
        ? table.split(".", 2)
        : ["public", table];

      try {
        await pool.query(
          `VACUUM (ANALYZE, VERBOSE FALSE) ${quoteIdentifier(schema)}.${quoteIdentifier(
            bareTable,
          )}`,
        );
        processed.push({ schema, table: bareTable, deadTuples: 0 });
        logger.info(
          { table: `${schema}.${bareTable}` },
          "[db-optimization] vacuum analyze complete",
        );
      } catch (error) {
        if (isRelationMissing(error)) {
          logger.debug(
            { table: `${schema}.${bareTable}` },
            "[db-optimization] skipping missing table",
          );
          continue;
        }
        logger.warn(
          { table: `${schema}.${bareTable}`, error },
          "[db-optimization] vacuum analyze failed",
        );
      }
    }

    return processed;
  }

  /**
   * Report dead-tuple counts for the configured tables so operators can confirm
   * that autovacuum is keeping up before the manual pass runs.
   */
  async collectDeadTupleStats(): Promise<
    Array<{ table: string; deadTuples: number; liveTuples: number }>
  > {
    const { rows } = await queryRead<
      { relname: string; n_dead_tup: number; n_live_tup: number }
    >(
      `SELECT s.relname,
              s.n_dead_tup::bigint   AS n_dead_tup,
              s.n_live_tup::bigint   AS n_live_tup
         FROM pg_stat_user_tables s
        WHERE s.relname = ANY($1::text[])`,
      [this.config.vacuumTargets.map((t) => t.split(".").pop() ?? t)],
    );

    return rows.map((row) => ({
      table: row.relname,
      deadTuples: Number(row.n_dead_tup ?? 0),
      liveTuples: Number(row.n_live_tup ?? 0),
    }));
  }

  // -------------------------------------------------------------------------
  // 2. Index fragmentation monitoring
  // -------------------------------------------------------------------------

  /**
   * Measure leaf density for every index above the size floor and persist the
   * sample. Indexes whose density cannot be read (no `pgstattuple` extension,
   * system index, …) are skipped rather than failing the whole cycle.
   */
  async monitorIndexFragmentation(
    minSizeMb: number = this.config.minIndexSizeMb,
  ): Promise<FragmentationSample[]> {
    const { rows } = await queryRead<{
      schemaname: string;
      tablename: string;
      indexname: string;
      size_bytes: string;
    }>(
      `SELECT s.schemaname,
              s.tablename,
              s.indexname,
              pg_relation_size(i.indexrelid) AS size_bytes
         FROM pg_stat_user_indexes s
         JOIN pg_index i ON i.indexrelid = s.indexrelid
        WHERE s.schemaname = 'public'
          AND NOT i.indisprimary
          AND NOT i.indisunique
          AND pg_relation_size(i.indexrelid) >= $1
        ORDER BY pg_relation_size(i.indexrelid) DESC`,
      [minSizeMb * 1024 * 1024],
    );

    const samples: FragmentationSample[] = [];

    for (const row of rows) {
      const leafDensity = await this.readLeafDensity(
        row.schemaname,
        row.indexname,
      );
      if (leafDensity === null) continue;

      const fragmentationPct = Math.max(0, 100 - leafDensity);
      const sample: FragmentationSample = {
        schema: row.schemaname,
        table: row.tablename,
        index: row.indexname,
        sizeBytes: Number(row.size_bytes),
        leafDensity,
        fragmentationPct,
        needsRebuild: fragmentationPct >= this.config.rebuildThresholdPct,
      };

      samples.push(sample);
      await this.recordFragmentationSample(sample);
    }

    return samples;
  }

  private async readLeafDensity(
    schema: string,
    index: string,
  ): Promise<number | null> {
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(index)}`;
    try {
      const { rows } = await queryRead<{ avg_leaf_density: number | null }>(
        "SELECT avg_leaf_density FROM pgstatindex($1)",
        [qualified],
      );
      const density = rows[0]?.avg_leaf_density;
      if (density === null || density === undefined) return null;
      const value = Number(density);
      return Number.isFinite(value) ? value : null;
    } catch (error) {
      logger.debug(
        { index: qualified, error },
        "[db-optimization] unable to read leaf density",
      );
      return null;
    }
  }

  private async recordFragmentationSample(
    sample: FragmentationSample,
  ): Promise<void> {
    try {
      await queryWrite(
        `INSERT INTO index_fragmentation_history
           (schemaname, tablename, indexname, size_bytes,
            leaf_density, fragmentation_pct, needs_rebuild)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          sample.schema,
          sample.table,
          sample.index,
          sample.sizeBytes,
          sample.leafDensity,
          sample.fragmentationPct,
          sample.needsRebuild,
        ],
      );
    } catch (error) {
      logger.warn(
        { index: sample.index, error },
        "[db-optimization] failed to persist fragmentation sample",
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. Index reorganisation
  // -------------------------------------------------------------------------

  /**
   * Rebuild the indexes flagged by {@link monitorIndexFragmentation}. Any
   * index rebuilt inside the cooldown window is skipped, and failures caused
   * by a concurrent rebuild are treated as a no-op.
   */
  async reorganizeIndexes(
    samples: FragmentationSample[] = [],
  ): Promise<{ rebuilt: string[]; skipped: string[] }> {
    const rebuilt: string[] = [];
    const skipped: string[] = [];

    for (const sample of samples.filter((s) => s.needsRebuild)) {
      const recentlyRebuilt = await this.wasRecentlyRebuilt(
        sample.index,
        this.config.reindexCooldownHours,
      );
      if (recentlyRebuilt) {
        skipped.push(sample.index);
        continue;
      }

      try {
        // CONCURRENTLY keeps reads and writes flowing, at the cost of two
        // table scans – which is exactly why it is limited to big indexes.
        await pool.query(
          `REINDEX INDEX CONCURRENTLY ${quoteIdentifier(
            sample.schema,
          )}.${quoteIdentifier(sample.index)}`,
        );
        rebuilt.push(sample.index);
        logger.info(
          { index: sample.index, fragmentationPct: sample.fragmentationPct },
          "[db-optimization] index reorganized",
        );
      } catch (error) {
        if (isIndexInUse(error)) {
          skipped.push(sample.index);
          continue;
        }
        logger.warn(
          { index: sample.index, error },
          "[db-optimization] reindex failed",
        );
      }
    }

    return { rebuilt, skipped };
  }

  private async wasRecentlyRebuilt(
    index: string,
    cooldownHours: number,
  ): Promise<boolean> {
    try {
      const { rows } = await queryRead<{ recent: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM index_fragmentation_history
            WHERE indexname = $1
              AND needs_rebuild = FALSE
              AND created_at > NOW() - ($2 || ' hours')::interval
         ) AS recent`,
        [index, String(cooldownHours)],
      );
      return Boolean(rows[0]?.recent);
    } catch {
      // Telemetry unavailable – err on the side of rebuilding.
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 4. Query plan cache
  // -------------------------------------------------------------------------

  /**
   * Normalise a query so semantically identical statements share a cache
   * entry: whitespace is collapsed, literals are replaced with `$n` and
   * comments stripped. The normalised text is hashed with SHA-256.
   */
  static fingerprintQuery(sql: string): { hash: string; fingerprint: string } {
    const fingerprint = sql
      .replace(/--[^\n]*/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/'([^']|'')*'/g, "'?'")
      .replace(/\b\d+(\.\d+)?\b/g, "?")
      .replace(/\s+/g, " ")
      .trim();

    return {
      hash: createHash("sha256").update(fingerprint).digest("hex"),
      fingerprint,
    };
  }

  /**
   * Store (or refresh) the plan for a query. When a previous plan exists and
   * the new cost exceeds it by more than the configured ratio the entry is
   * flagged as a regression and a warning is logged.
   */
  async cacheQueryPlan(
    sql: string,
    plan: Record<string, unknown>,
    planCost?: number | null,
  ): Promise<CachedQueryPlan> {
    const { hash, fingerprint } =
      DatabaseOptimizationService.fingerprintQuery(sql);
    const cost = planCost ?? DatabaseOptimizationService.extractPlanCost(plan);

    const existing = await this.getCachedQueryPlan(sql, { touch: false });
    const isRegression =
      existing?.planCost != null &&
      cost != null &&
      cost > existing.planCost * this.config.planRegressionRatio;

    if (isRegression) {
      logger.warn(
        { hash, previousCost: existing?.planCost, cost },
        "[db-optimization] query plan regression detected",
      );
    }

    const { rows } = await queryWrite<Record<string, any>>(
      `INSERT INTO query_plan_cache
         (query_hash, query_fingerprint, plan, plan_cost, is_regression, last_used_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (query_hash) DO UPDATE
         SET plan = EXCLUDED.plan,
             plan_cost = EXCLUDED.plan_cost,
             is_regression = EXCLUDED.is_regression,
             last_used_at = NOW()
       RETURNING query_hash, query_fingerprint, plan, plan_cost,
                 hit_count, is_regression, last_used_at`,
      [hash, fingerprint, JSON.stringify(plan), cost, isRegression],
    );

    return mapPlanRow(rows[0]);
  }

  /**
   * Look up a cached plan. `touch` increments the hit counter and refreshes
   * `last_used_at`, which is what feeds the eviction candidates query.
   */
  async getCachedQueryPlan(
    sql: string,
    options: { touch?: boolean } = {},
  ): Promise<CachedQueryPlan | null> {
    const { hash } = DatabaseOptimizationService.fingerprintQuery(sql);

    if (options.touch === false) {
      const { rows } = await queryRead<Record<string, any>>(
        `SELECT query_hash, query_fingerprint, plan, plan_cost,
                hit_count, is_regression, last_used_at
           FROM query_plan_cache WHERE query_hash = $1`,
        [hash],
      );
      return rows[0] ? mapPlanRow(rows[0]) : null;
    }

    const { rows } = await queryWrite<Record<string, any>>(
      `UPDATE query_plan_cache
          SET hit_count = hit_count + 1, last_used_at = NOW()
        WHERE query_hash = $1
        RETURNING query_hash, query_fingerprint, plan, plan_cost,
                  hit_count, is_regression, last_used_at`,
      [hash],
    );
    return rows[0] ? mapPlanRow(rows[0]) : null;
  }

  /**
   * Pull the total cost out of an `EXPLAIN (FORMAT JSON)` payload. Returns
   * `null` when the plan shape is not recognised rather than guessing.
   */
  static extractPlanCost(plan: Record<string, unknown>): number | null {
    const candidates = [plan?.["Plan Cost"], (plan as any)?.plan?.total_cost];
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  /** Prune cache entries untouched for longer than the retention window. */
  async pruneQueryPlanCache(retentionHours = 168): Promise<number> {
    const { rowCount } = await queryWrite(
      `DELETE FROM query_plan_cache WHERE last_used_at < NOW() - ($1 || ' hours')::interval`,
      [String(retentionHours)],
    );
    return rowCount ?? 0;
  }

  /** Snapshot of plan-cache health, surfaced on the admin dashboard. */
  async getPlanCacheStats(): Promise<{
    totalEntries: number;
    regressions: number;
    avgHitCount: number;
  }> {
    const { rows } = await queryRead<Record<string, number>>(
      `SELECT COUNT(*)::bigint                     AS total_entries,
              COUNT(*) FILTER (WHERE is_regression)::bigint AS regressions,
              COALESCE(AVG(hit_count), 0)::float   AS avg_hit_count
         FROM query_plan_cache`,
    );
    const row = rows[0] ?? {};
    return {
      totalEntries: Number(row.total_entries ?? 0),
      regressions: Number(row.regressions ?? 0),
      avgHitCount: Number(row.avg_hit_count ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------

  /**
   * Full optimisation cycle: vacuum/analyse, fragment detection, conditional
   * reindex and plan-cache maintenance. Never throws – a failed cycle is
   * recorded and the next scheduled run tries again.
   */
  async runOptimizationCycle(): Promise<OptimizationRunReport> {
    const startedAt = Date.now();
    const report: OptimizationRunReport = {
      vacuumAnalyzed: 0,
      reindexed: 0,
      fragmentedIndexes: 0,
      planCacheEntries: 0,
      durationMs: 0,
    };

    try {
      const vacuumed = await this.vacuumAndAnalyze();
      report.vacuumAnalyzed = vacuumed.length;

      const samples = await this.monitorIndexFragmentation();
      report.fragmentedIndexes = samples.filter((s) => s.needsRebuild).length;

      const { rebuilt } = await this.reorganizeIndexes(samples);
      report.reindexed = rebuilt.length;

      await this.pruneQueryPlanCache();
      const stats = await this.getPlanCacheStats();
      report.planCacheEntries = stats.totalEntries;

      await this.recordRun(report, "completed");
    } catch (error) {
      logger.error({ error }, "[db-optimization] optimization cycle failed");
      report.durationMs = Date.now() - startedAt;
      await this.recordRun(report, "failed", String(error));
      return report;
    }

    report.durationMs = Date.now() - startedAt;
    await this.recordRun(report, "completed");
    logger.info({ report }, "[db-optimization] optimization cycle complete");
    return report;
  }

  private async recordRun(
    report: OptimizationRunReport,
    status: "completed" | "failed",
    error?: string,
  ): Promise<void> {
    try {
      await queryWrite(
        `INSERT INTO database_optimization_runs
           (vacuum_analyzed, reindexed, fragmented_indexes,
            plan_cache_entries, duration_ms, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          report.vacuumAnalyzed,
          report.reindexed,
          report.fragmentedIndexes,
          report.planCacheEntries,
          report.durationMs,
          status,
          error ?? null,
        ],
      );
    } catch (writeError) {
      logger.warn(
        { error: writeError },
        "[db-optimization] failed to record run telemetry",
      );
    }
  }
}

function mapPlanRow(row: Record<string, any>): CachedQueryPlan {
  return {
    queryHash: String(row.query_hash),
    fingerprint: row.query_fingerprint,
    plan: row.plan,
    planCost: row.plan_cost == null ? null : Number(row.plan_cost),
    hitCount: Number(row.hit_count ?? 0),
    isRegression: Boolean(row.is_regression),
    lastUsedAt: new Date(row.last_used_at),
  };
}

export const databaseOptimizationService = new DatabaseOptimizationService();
