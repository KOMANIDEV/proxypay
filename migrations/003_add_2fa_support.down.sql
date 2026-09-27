-- Rollback: 003_add_2fa_support
-- Inverted from 003_add_2fa_support.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS backup_codes_used_at ON backup_codes;
ALTER TABLE users DROP COLUMN IF EXISTS two_factor_secret;
ALTER TABLE users DROP COLUMN IF EXISTS two_factor_enabled;
ALTER TABLE users DROP COLUMN IF EXISTS two_factor_verified;
ALTER TABLE users DROP COLUMN IF EXISTS email;
DROP TABLE IF EXISTS backup_codes;
DROP INDEX IF EXISTS idx_backup_codes_user_id;
DROP INDEX IF EXISTS idx_backup_codes_used;
DROP INDEX IF EXISTS idx_users_email;
DROP FUNCTION IF EXISTS update_backup_codes_used_at;
