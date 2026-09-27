-- Rollback: 20260825_create_kyc_webhook_tables
-- Inverted from 20260825_create_kyc_webhook_tables.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS trg_kyc_webhook_deliveries_updated_at ON kyc_webhook_deliveries;
DROP TABLE IF EXISTS kyc_webhook_deliveries;
DROP TABLE IF EXISTS kyc_webhook_configs;
DROP INDEX IF EXISTS idx_kyc_webhook_configs_user_id;
DROP INDEX IF EXISTS idx_kyc_webhook_deliveries_pending;
DROP INDEX IF EXISTS idx_kyc_webhook_deliveries_user_id;
DROP INDEX IF EXISTS idx_kyc_webhook_deliveries_event_id;
DROP FUNCTION IF EXISTS set_kyc_webhook_deliveries_updated_at;
