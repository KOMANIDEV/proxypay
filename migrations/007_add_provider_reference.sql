-- Migration: 007_add_provider_reference
-- Description: Add external provider reference ID to transactions table

ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(100);

-- Index for support lookups
CREATE INDEX IF NOT EXISTS idx_transactions_provider_reference ON transactions(provider_reference);