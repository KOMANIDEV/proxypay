-- Rollback: 20260424_add_sms_opt_out_to_users
-- Inverted from 20260424_add_sms_opt_out_to_users.sql; hand-verified against the up migration.

ALTER TABLE users DROP COLUMN IF EXISTS sms_opt_out;
