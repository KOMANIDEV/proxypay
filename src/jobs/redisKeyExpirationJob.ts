/**
 * Redis Key Expiration Monitoring and Cleanup Job — Issue #292
 *
 * Schedule: Every 10 minutes (configurable via REDIS_EXPIRY_MONITOR_CRON)
 *
 * Responsibilities:
 *   1. Collect Redis memory and keyspace statistics via the INFO command.
 *   2. Track key eviction and expiration patterns.
 *   3. Alert (log warning / emit Prometheus metric) when the eviction rate
 *      exceeds the configured threshold.
 *   4. Scan for and delete orphaned keys matching configurable prefix patterns
 *      that should have expired but remain in memory (e.g. due to stale TTL
 *      bugs or keys written without a TTL).
 *
 * Configuration (all optional — sensible defaults are applied):
 *   REDIS_EXPIRY_MONITOR_CRON          Cron expression (default: every 10 min)
 *   REDIS_EVICTION_RATE_ALERT_THRESHOLD  Max evictions/sec before alert (default: 100)
 *   REDIS_ORPHAN_KEY_PREFIXES          Comma-separated prefixes to scan for orphans
 *                                      (default: 'idempotency:,session:,otp:,lock:')
 *   REDIS_ORPHAN_MAX_TTL_SECONDS       Keys matching prefixes with TTL > this value
 *                                      are treated as orphans (default: 86400 = 24 h)
 *   REDIS_ORPHAN_SCAN_COUNT            SCAN count hint per iteration (default: 100)
 *   REDIS_CLEANUP_DRY_RUN              When 'true', log but do not delete (default: false)
 */

import { redisClient } from '../config/redis';
import logger from '../services/logger';
import { Gauge, Counter, Registry } from 'prom-client';

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

const metricsRegistry = new Registry();

const redisMemoryUsageBytes = new Gauge({
  name: 'redis_memory_usage_bytes',
  help: 'Current Redis memory usage in bytes (used_memory)',
  registers: [metricsRegistry],
});

const redisKeyspaceHits = new Gauge({
  name: 'redis_keyspace_hits_total',
  help: 'Cumulative number of successful key lookups',
  registers: [metricsRegistry],
});

const redisKeyspaceMisses = new Gauge({
  name: 'redis_keyspace_misses_total',
  help: 'Cumulative number of failed key lookups',
  registers: [metricsRegistry],
});

const redisEvictedKeysTotal = new Gauge({
  name: 'redis_evicted_keys_total',
  help: 'Total number of keys evicted due to maxmemory policy',
  registers: [metricsRegistry],
});

const redisExpiredKeysTotal = new Gauge({
  name: 'redis_expired_keys_total',
  help: 'Total number of keys expired by TTL',
  registers: [metricsRegistry],
});

const redisOrphanKeysDeleted = new Counter({
  name: 'redis_orphan_keys_deleted_total',
  help: 'Total number of orphaned Redis keys deleted by the cleanup job',
  registers: [metricsRegistry],
});

const redisHighEvictionAlert = new Counter({
  name: 'redis_high_eviction_alert_total',
  help: 'Number of times the eviction rate exceeded the alert threshold',
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EVICTION_RATE_ALERT_THRESHOLD = parseInt(
  process.env.REDIS_EVICTION_RATE_ALERT_THRESHOLD || '100',
  10,
);

const ORPHAN_KEY_PREFIXES: string[] = (
  process.env.REDIS_ORPHAN_KEY_PREFIXES || 'idempotency:,session:,otp:,lock:'
)
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

const ORPHAN_MAX_TTL_SECONDS = parseInt(
  process.env.REDIS_ORPHAN_MAX_TTL_SECONDS || '86400',
  10,
);

const SCAN_COUNT = parseInt(process.env.REDIS_ORPHAN_SCAN_COUNT || '100', 10);

const DRY_RUN = process.env.REDIS_CLEANUP_DRY_RUN === 'true';

// ---------------------------------------------------------------------------
// Redis INFO parser
// ---------------------------------------------------------------------------

interface RedisInfo {
  usedMemoryBytes: number;
  keyspaceHits: number;
  keyspaceMisses: number;
  evictedKeys: number;
  expiredKeys: number;
  instantaneousOpsPerSec: number;
}

/**
 * Parses the flat key:value output of the Redis INFO command.
 */
function parseRedisInfo(raw: string): RedisInfo {
  const getValue = (key: string): number => {
    const match = raw.match(new RegExp(`^${key}:(\\d+)`, 'm'));
    return match ? parseInt(match[1], 10) : 0;
  };

  return {
    usedMemoryBytes: getValue('used_memory'),
    keyspaceHits: getValue('keyspace_hits'),
    keyspaceMisses: getValue('keyspace_misses'),
    evictedKeys: getValue('evicted_keys'),
    expiredKeys: getValue('expired_keys'),
    instantaneousOpsPerSec: getValue('instantaneous_ops_per_sec'),
  };
}

// ---------------------------------------------------------------------------
// Metrics collection
// ---------------------------------------------------------------------------

/**
 * Queries Redis INFO and updates Prometheus gauges.
 */
async function collectRedisMetrics(): Promise<RedisInfo> {
  // Fetch both stats and keyspace sections in one call
  const raw = await redisClient.info('all');
  const info = parseRedisInfo(raw);

  redisMemoryUsageBytes.set(info.usedMemoryBytes);
  redisKeyspaceHits.set(info.keyspaceHits);
  redisKeyspaceMisses.set(info.keyspaceMisses);
  redisEvictedKeysTotal.set(info.evictedKeys);
  redisExpiredKeysTotal.set(info.expiredKeys);

  logger.info({
    msg: '[redis-expiry-monitor] Redis stats collected',
    usedMemoryMB: (info.usedMemoryBytes / 1024 / 1024).toFixed(2),
    evictedKeys: info.evictedKeys,
    expiredKeys: info.expiredKeys,
    opsPerSec: info.instantaneousOpsPerSec,
  });

  return info;
}

// ---------------------------------------------------------------------------
// Eviction rate alert
// ---------------------------------------------------------------------------

/** Previous run's evicted key count to compute the rate delta. */
let previousEvictedKeys = 0;
let previousRunTime = Date.now();

function checkEvictionRate(currentEvictedKeys: number): void {
  const now = Date.now();
  const elapsedSeconds = (now - previousRunTime) / 1000;
  const delta = currentEvictedKeys - previousEvictedKeys;

  if (previousEvictedKeys > 0 && elapsedSeconds > 0) {
    const ratePerSecond = delta / elapsedSeconds;

    if (ratePerSecond > EVICTION_RATE_ALERT_THRESHOLD) {
      redisHighEvictionAlert.inc();
      logger.warn({
        msg: '[redis-expiry-monitor] HIGH eviction rate detected',
        ratePerSecond: ratePerSecond.toFixed(2),
        threshold: EVICTION_RATE_ALERT_THRESHOLD,
        deltaKeys: delta,
        elapsedSeconds: elapsedSeconds.toFixed(1),
      });
    }
  }

  previousEvictedKeys = currentEvictedKeys;
  previousRunTime = now;
}

// ---------------------------------------------------------------------------
// Orphan key cleanup
// ---------------------------------------------------------------------------

/**
 * Scans Redis for keys matching the configured prefixes and removes any whose
 * TTL exceeds the orphan threshold or have no TTL set (-1).
 *
 * Uses SCAN (non-blocking) to avoid stalling the server.
 */
async function cleanupOrphanKeys(): Promise<number> {
  let totalDeleted = 0;

  for (const prefix of ORPHAN_KEY_PREFIXES) {
    let cursor = 0;
    let prefixDeleted = 0;

    do {
      const { cursor: nextCursor, keys } = await redisClient.scan(cursor, {
        MATCH: `${prefix}*`,
        COUNT: SCAN_COUNT,
      });

      cursor = nextCursor;

      for (const key of keys) {
        const ttl = await redisClient.ttl(key);

        // ttl === -1 means key has no expiry (orphaned)
        // ttl > ORPHAN_MAX_TTL_SECONDS means abnormally long TTL
        const isOrphan = ttl === -1 || ttl > ORPHAN_MAX_TTL_SECONDS;

        if (isOrphan) {
          if (DRY_RUN) {
            logger.info({
              msg: '[redis-expiry-monitor] DRY RUN: would delete orphan key',
              key,
              ttl,
            });
          } else {
            await redisClient.del(key);
            prefixDeleted++;
            totalDeleted++;
            redisOrphanKeysDeleted.inc();
          }
        }
      }
    } while (cursor !== 0);

    if (prefixDeleted > 0) {
      logger.info({
        msg: '[redis-expiry-monitor] Orphan key cleanup complete for prefix',
        prefix,
        deleted: prefixDeleted,
        dryRun: DRY_RUN,
      });
    }
  }

  return totalDeleted;
}

// ---------------------------------------------------------------------------
// Job entry point
// ---------------------------------------------------------------------------

/**
 * Main job function.  Called by the scheduler on each run.
 *
 * Steps:
 *   1. Collect and publish Redis memory / keyspace metrics.
 *   2. Check if the eviction rate has exceeded the alert threshold.
 *   3. Scan for and delete orphaned keys.
 */
export async function runRedisKeyExpirationMonitorJob(): Promise<void> {
  logger.info({ msg: '[redis-expiry-monitor] Starting Redis key expiration monitor job' });

  try {
    const info = await collectRedisMetrics();
    checkEvictionRate(info.evictedKeys);
    const deleted = await cleanupOrphanKeys();

    logger.info({
      msg: '[redis-expiry-monitor] Job completed',
      orphanKeysDeleted: deleted,
      dryRun: DRY_RUN,
    });
  } catch (err) {
    logger.error({
      err,
      msg: '[redis-expiry-monitor] Job failed with an unexpected error',
    });
  }
}

/** Export the job-specific metrics registry for inclusion in the global /metrics endpoint. */
export { metricsRegistry as redisMonitorMetricsRegistry };
