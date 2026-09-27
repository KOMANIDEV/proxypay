-- Rollback: 009_add_profile_url_to_users
-- Inverted from 009_add_profile_url_to_users.sql; hand-verified against the up migration.

ALTER TABLE users DROP COLUMN IF EXISTS profile_url;
