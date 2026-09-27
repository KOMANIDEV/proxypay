-- Rollback: 20260529_add_transaction_keyset_indexes
-- Inverted from 20260529_add_transaction_keyset_indexes.sql; hand-verified against the up migration.

DROP INDEX IF EXISTS idx_transactions_created_id;
DROP INDEX IF EXISTS idx_transactions_status_created_id;
DROP INDEX IF EXISTS idx_transactions_user_created_id;
DROP INDEX IF EXISTS idx_transactions_provider_created_id;
