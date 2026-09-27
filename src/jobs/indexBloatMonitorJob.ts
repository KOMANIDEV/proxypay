import { pool } from "../config/database";
import {
  INDEX_BLOAT_ALERT_THRESHOLD_PCT,
  INDEX_BLOAT_MIN_SIZE_MB,
  INDEX_BLOAT_MONITOR_ENABLED,
} from "../config/env";
import { notifySlackAlert } from "../services/loggers";
import { indexBloatPercentage } from "../utils/metrics";

interface IndexBloatCandidate {
  schemaname: string;
  tablename: string;
  indexname: string;
  size_bytes: number;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function getIndexesToCheck(): Promise<IndexBloatCandidate[]> {
  const result = await pool.query<IndexBloatCandidate>(
    `SELECT
       s.schemaname,
       s.tablename,
       s.indexname,
       pg_relation_size(i.indexrelid) AS size_bytes
     FROM pg_stat_user_indexes s
     JOIN pg_index i ON i.indexrelid = s.indexrelid
     WHERE s.schemaname = 'public'
       AND pg_relation_size(i.indexrelid) >= $1
     ORDER BY pg_relation_size(i.indexrelid) DESC`,
    [INDEX_BLOAT_MIN_SIZE_MB * 1024 * 1024],
  );

  return result.rows.map((row) => ({ ...row, size_bytes: Number(row.size_bytes) }));
}

async function getIndexBloatPct(
  schemaname: string,
  indexname: string,
): Promise<number | null> {
  const qualifiedName = `${quoteIdentifier(schemaname)}.${quoteIdentifier(indexname)}`;
  try {
    const result = await pool.query<{ avg_leaf_density: number | null }>(
      "SELECT avg_leaf_density FROM pgstatindex($1)",
      [qualifiedName],
    );
    const density = result.rows[0]?.avg_leaf_density;
    if (density === null || density === undefined) {
      return null;
    }
    return Math.max(0, 100 - Number(density));
  } catch (error) {
    console.warn(
      `[index-bloat-monitor] Failed to compute bloat for ${qualifiedName}:`,
      error,
    );
    return null;
  }
}

async function recordBloatHistory(
  candidate: IndexBloatCandidate,
  bloatPct: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO index_bloat_history (schemaname, tablename, indexname, size_bytes, bloat_pct)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      candidate.schemaname,
      candidate.tablename,
      candidate.indexname,
      candidate.size_bytes,
      bloatPct,
    ],
  );
}

export async function runIndexBloatMonitorJob(): Promise<void> {
  console.info("[index-bloat-monitor] Starting index bloat monitoring job");

  if (!INDEX_BLOAT_MONITOR_ENABLED) {
    console.info(
      "[index-bloat-monitor] Skipping because INDEX_BLOAT_MONITOR_ENABLED=false",
    );
    return;
  }

  const candidates = await getIndexesToCheck();
  if (candidates.length === 0) {
    console.info("[index-bloat-monitor] No indexes found to check");
    return;
  }

  for (const candidate of candidates) {
    const bloatPct = await getIndexBloatPct(candidate.schemaname, candidate.indexname);
    if (bloatPct === null) {
      continue;
    }

    indexBloatPercentage.set(
      {
        schemaname: candidate.schemaname,
        tablename: candidate.tablename,
        indexname: candidate.indexname,
      },
      bloatPct,
    );

    await recordBloatHistory(candidate, bloatPct);

    if (bloatPct >= INDEX_BLOAT_ALERT_THRESHOLD_PCT) {
      console.warn(
        `[index-bloat-monitor] ALERT: ${candidate.schemaname}.${candidate.indexname} bloat=${bloatPct.toFixed(2)}% (threshold=${INDEX_BLOAT_ALERT_THRESHOLD_PCT}%)`,
      );

      await notifySlackAlert(
        {
          statusCode: 500,
          method: "MONITOR",
          path: `/index-bloat/${candidate.schemaname}.${candidate.indexname}`,
          timestamp: new Date().toISOString(),
          error: new Error(
            `Index bloat alert: ${candidate.schemaname}.${candidate.indexname} is ${bloatPct.toFixed(
              2,
            )}% bloated (threshold: ${INDEX_BLOAT_ALERT_THRESHOLD_PCT}%). Run the index-reindex job or 'npm run reindex:bloated-indexes' to remediate.`,
          ),
        },
        { appName: "index-bloat-monitor" },
      );
    }
  }

  console.info(
    `[index-bloat-monitor] Checked ${candidates.length} index(es) for bloat`,
  );
}
