-- Rollback: 20260531_create_pii_audit_table
-- Inverted from 20260531_create_pii_audit_table.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS pii_access_audit_logs;
DROP INDEX IF EXISTS idx_pii_audit_admin_id;
DROP INDEX IF EXISTS idx_pii_audit_target_id;
DROP INDEX IF EXISTS idx_pii_audit_accessed_at;
