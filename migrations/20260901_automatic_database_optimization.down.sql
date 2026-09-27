-- Rollback: 20260901_automatic_database_optimization
-- Drops the optimisation telemetry tables in reverse dependency order.

DROP INDEX IF EXISTS idx_db_optimization_runs_created;
DROP TABLE IF EXISTS database_optimization_runs;

DROP INDEX IF EXISTS idx_index_fragmentation_needs_rebuild;
DROP INDEX IF EXISTS idx_index_fragmentation_index;
DROP TABLE IF EXISTS index_fragmentation_history;

DROP INDEX IF EXISTS idx_query_plan_cache_regressions;
DROP INDEX IF EXISTS idx_query_plan_cache_last_used;
DROP TABLE IF EXISTS query_plan_cache;
