-- Rollback: 010_add_fee_and_provider_fee_to_transactions
-- Inverted from 010_add_fee_and_provider_fee_to_transactions.sql; hand-verified against the up migration.

ALTER TABLE transactions DROP COLUMN IF EXISTS fee_amount;
ALTER TABLE transactions DROP COLUMN IF EXISTS provider_fee;
