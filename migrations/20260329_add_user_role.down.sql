-- Rollback: 20260329_add_user_role
-- Inverted from 20260329_add_user_role.sql; hand-verified against the up migration.

ALTER TABLE users DROP COLUMN IF EXISTS role_id;
DROP INDEX IF EXISTS idx_users_role_id;
