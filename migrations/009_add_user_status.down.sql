-- Rollback: 009_add_user_status
-- Inverted from 009_add_user_status.sql; hand-verified against the up migration.

ALTER TABLE users DROP COLUMN IF EXISTS status;
DROP TABLE IF EXISTS user_status_audit;
DROP INDEX IF EXISTS idx_users_status;
DROP INDEX IF EXISTS idx_user_status_audit_user_id;
DROP INDEX IF EXISTS idx_user_status_audit_changed_by;
DROP INDEX IF EXISTS idx_user_status_audit_created_at;
