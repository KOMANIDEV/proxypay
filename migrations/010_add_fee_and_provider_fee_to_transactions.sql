-- Migration: 010_add_fee_and_provider_fee_to_transactions
-- Description: Add fee_amount and provider_fee columns to transactions
--              required for PnL aggregation

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS fee_amount   DECIMAL(20, 7) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_fee DECIMAL(20, 7) NOT NULL DEFAULT 0;
