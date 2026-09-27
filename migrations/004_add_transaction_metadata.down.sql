-- Rollback: 004_add_transaction_metadata
-- Inverted from 004_add_transaction_metadata.sql; hand-verified against the up migration.

ALTER TABLE transactions DROP COLUMN IF EXISTS metadata;
DROP INDEX IF EXISTS idx_transactions_metadata;
