-- Rollback: 20260825_provider_health_dashboard
-- Inverted from 20260825_provider_health_dashboard.sql; hand-verified against the up migration.

DROP MATERIALIZED VIEW IF EXISTS mv_provider_current_health;
DROP TABLE IF EXISTS provider_health_snapshots;
DROP INDEX IF EXISTS idx_provider_health_snapshots_provider_hour;
DROP INDEX IF EXISTS idx_provider_health_snapshots_hour;
DROP INDEX IF EXISTS idx_mv_provider_current_health_provider;
