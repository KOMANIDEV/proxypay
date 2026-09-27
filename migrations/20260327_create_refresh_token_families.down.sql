-- Rollback: 20260327_create_refresh_token_families
-- Inverted from 20260327_create_refresh_token_families.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS refresh_token_families;
DROP INDEX IF EXISTS idx_refresh_token_families_family_id;
DROP INDEX IF EXISTS idx_refresh_token_families_token;
