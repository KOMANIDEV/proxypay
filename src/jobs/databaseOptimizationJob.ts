/**
 * #482 – Automatic Database Optimization (scheduled job)
 *
 * Runs the full optimisation cycle: VACUUM ANALYZE for the hot tables,
 * index fragmentation measurement, conditional REINDEX and query plan cache
 * maintenance. Scheduled during the low-traffic window so the REINDEX passes
 * do not compete with peak request traffic.
 */

import { databaseOptimizationService } from "../services/databaseOptimizationService";
import { DB_OPTIMIZATION_JOB_ENABLED } from "../config/env";
import { notifySlackAlert } from "../services/loggers";

export async function runDatabaseOptimizationJob(): Promise<void> {
  console.info("[db-optimization] Starting automatic database optimization");

  if (!DB_OPTIMIZATION_JOB_ENABLED) {
    console.info(
      "[db-optimization] Skipping because DB_OPTIMIZATION_JOB_ENABLED=false",
    );
    return;
  }

  const report = await databaseOptimizationService.runOptimizationCycle();

  if (report.reindexed > 0) {
    console.info(
      `[db-optimization] Reorganized ${report.reindexed} fragmented index(es)`,
    );
  }

  if (report.vacuumAnalyzed === 0 && report.reindexed === 0) {
    console.info(
      "[db-optimization] Nothing to optimize – all tables and indexes healthy",
    );
    return;
  }

  await notifySlackAlert(
    {
      statusCode: 200,
      method: "MONITOR",
      path: `/database-optimization/${report.durationMs}ms`,
      timestamp: new Date().toISOString(),
      error: new Error(
        `Database optimization completed in ${report.durationMs}ms: ` +
          `${report.vacuumAnalyzed} table(s) vacuumed, ` +
          `${report.fragmentedIndexes} fragmented index(es) detected, ` +
          `${report.reindexed} index(es) reorganized, ` +
          `${report.planCacheEntries} cached query plan(s).`,
      ),
    },
    { appName: "db-optimization" },
  );

  console.info("[db-optimization] Completed", report);
}
