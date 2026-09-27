-- Rollback: 20260329_add_user_backup_codes
-- Inverted from 20260329_add_user_backup_codes.sql; hand-verified against the up migration.

ALTER TABLE users DROP COLUMN IF EXISTS backup_codes;
DROP INDEX IF EXISTS idx_users_backup_codes;
