-- Rollback: 20260730_create_index_bloat_monitoring
-- Inverted from 20260730_create_index_bloat_monitoring.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS index_bloat_history;
DROP INDEX IF EXISTS idx_index_bloat_history_index;
DROP INDEX IF EXISTS idx_index_bloat_history_checked_at;
DROP EXTENSION IF EXISTS pgstattuple;
