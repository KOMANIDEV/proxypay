-- Migration: 20260421_add_provider_reference_to_transactions
-- NOTE: 007_add_provider_reference already created provider_reference as
-- VARCHAR(100). This migration widens it to VARCHAR(255). The column must not
-- be dropped by the down migration (it predates this migration).

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(255);

ALTER TABLE transactions
  ALTER COLUMN provider_reference TYPE VARCHAR(255);
