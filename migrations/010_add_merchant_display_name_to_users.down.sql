-- Rollback: 010_add_merchant_display_name_to_users
-- Inverted from 010_add_merchant_display_name_to_users.sql; hand-verified against the up migration.

ALTER TABLE users DROP COLUMN IF EXISTS display_name;
