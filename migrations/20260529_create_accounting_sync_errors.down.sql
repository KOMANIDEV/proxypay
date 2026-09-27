-- Rollback: 20260529_create_accounting_sync_errors
-- Inverted from 20260529_create_accounting_sync_errors.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS accounting_sync_errors_updated_at ON accounting_sync_errors;
DROP TABLE IF EXISTS accounting_sync_errors;
DROP INDEX IF EXISTS idx_accounting_sync_errors_transaction_id;
DROP INDEX IF EXISTS idx_accounting_sync_errors_provider_type;
DROP INDEX IF EXISTS idx_accounting_sync_errors_status;
DROP INDEX IF EXISTS idx_accounting_sync_errors_created_at;
DROP FUNCTION IF EXISTS update_accounting_sync_errors_updated_at;
