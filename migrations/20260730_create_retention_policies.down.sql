-- Rollback: 20260730_create_retention_policies
-- Inverted from 20260730_create_retention_policies.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS retention_purge_audit;
DROP TABLE IF EXISTS retention_policies;
DROP INDEX IF EXISTS idx_retention_purge_audit_executed_at;
DROP INDEX IF EXISTS idx_retention_purge_audit_data_type;
