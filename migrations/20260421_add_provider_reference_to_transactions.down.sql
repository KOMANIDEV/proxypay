-- Rollback: 20260421_add_provider_reference_to_transactions
-- Reverts the type widening. provider_reference was created by
-- 007_add_provider_reference (VARCHAR(100)) and must NOT be dropped here.

ALTER TABLE transactions
  ALTER COLUMN provider_reference TYPE VARCHAR(100);
