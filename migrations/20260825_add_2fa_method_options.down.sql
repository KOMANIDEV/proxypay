-- Rollback: 20260825_add_2fa_method_options
-- Inverted from 20260825_add_2fa_method_options.sql; hand-verified against the up migration.

ALTER TABLE users DROP COLUMN IF EXISTS primary_2fa_method;
DROP TABLE IF EXISTS webauthn_challenges;
DROP TABLE IF EXISTS webauthn_credentials;
DROP TABLE IF EXISTS user_2fa_methods;
DROP INDEX IF EXISTS idx_user_2fa_methods_user_id;
DROP INDEX IF EXISTS idx_webauthn_credentials_user_id;
DROP INDEX IF EXISTS idx_webauthn_challenges_user_id;
DROP FUNCTION IF EXISTS cleanup_expired_webauthn_challenges;
