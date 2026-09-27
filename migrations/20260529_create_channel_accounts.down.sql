-- Rollback: 20260529_create_channel_accounts
-- Inverted from 20260529_create_channel_accounts.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS trg_channel_accounts_updated_at ON channel_accounts;
DROP TABLE IF EXISTS channel_accounts;
DROP INDEX IF EXISTS idx_channel_accounts_status;
DROP INDEX IF EXISTS idx_channel_accounts_locked_at;
DROP FUNCTION IF EXISTS update_channel_accounts_updated_at;
