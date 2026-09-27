-- Rollback: 20260424_create_provider_api_calls
-- Inverted from 20260424_create_provider_api_calls.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS trg_trim_provider_api_calls ON provider_api_calls;
DROP TABLE IF EXISTS provider_api_calls;
DROP INDEX IF EXISTS idx_pac_provider_called_at;
DROP FUNCTION IF EXISTS trim_provider_api_calls;
