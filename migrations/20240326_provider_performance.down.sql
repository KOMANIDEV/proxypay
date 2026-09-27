-- Rollback: 20240326_provider_performance
-- Inverted from 20240326_provider_performance.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS provider_performance_logs;
DROP INDEX IF EXISTS idx_provider_performance_provider;
DROP INDEX IF EXISTS idx_provider_performance_created_at;
