-- Migration: 20260901_automatic_database_optimization
-- Description: Persistence layer for the automatic database optimisation
--              pipeline (#482):
--
--   * query_plan_cache      – cached EXPLAIN output for hot query shapes so
--                             repeated planning cost is avoided and plan
--                             regressions become observable.
--   * index_fragmentation_history – time series of index leaf-density bloat
--                             used to decide when a REINDEX is due.
--   * database_optimization_runs – one row per optimisation cycle recording
--                             what was vacuumed, analysed or rebuilt.
--
-- All statements are idempotent so the migration can be re-applied safely.

-- ---------------------------------------------------------------------------
-- 1. Query plan cache
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS query_plan_cache (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_hash       CHAR(64) NOT NULL,
    query_fingerprint TEXT NOT NULL,
    plan             JSONB NOT NULL,
    plan_cost        DOUBLE PRECISION,
    hit_count        BIGINT NOT NULL DEFAULT 0,
    is_regression    BOOLEAN NOT NULL DEFAULT FALSE,
    last_used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (query_hash)
);

CREATE INDEX IF NOT EXISTS idx_query_plan_cache_last_used
    ON query_plan_cache (last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_query_plan_cache_regressions
    ON query_plan_cache (is_regression, last_used_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Index fragmentation history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS index_fragmentation_history (
    id             BIGSERIAL PRIMARY KEY,
    schemaname     VARCHAR(64) NOT NULL,
    tablename      VARCHAR(64) NOT NULL,
    indexname      VARCHAR(128) NOT NULL,
    size_bytes     BIGINT NOT NULL,
    leaf_density   DOUBLE PRECISION,
    fragmentation_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    needs_rebuild  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_index_fragmentation_index
    ON index_fragmentation_history (indexname, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_index_fragmentation_needs_rebuild
    ON index_fragmentation_history (needs_rebuild, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Optimisation run history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS database_optimization_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vacuum_analyzed     INTEGER NOT NULL DEFAULT 0,
    reindexed           INTEGER NOT NULL DEFAULT 0,
    fragmented_indexes  INTEGER NOT NULL DEFAULT 0,
    plan_cache_entries  INTEGER NOT NULL DEFAULT 0,
    duration_ms         INTEGER NOT NULL DEFAULT 0,
    status              VARCHAR(20) NOT NULL DEFAULT 'completed',
    error               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_db_optimization_runs_created
    ON database_optimization_runs (created_at DESC);
