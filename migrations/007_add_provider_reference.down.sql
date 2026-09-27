-- Rollback: 007_add_provider_reference
-- Inverted from 007_add_provider_reference.sql; hand-verified against the up migration.

ALTER TABLE transactions DROP COLUMN IF EXISTS provider_reference;
DROP INDEX IF EXISTS idx_transactions_provider_reference;
