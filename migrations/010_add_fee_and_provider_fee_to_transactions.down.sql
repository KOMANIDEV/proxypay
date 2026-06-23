-- Rollback: 010_add_fee_and_provider_fee_to_transactions

ALTER TABLE transactions
  DROP COLUMN IF EXISTS fee_amount,
  DROP COLUMN IF EXISTS provider_fee;
