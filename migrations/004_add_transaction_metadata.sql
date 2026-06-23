-- Add metadata JSONB column to transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_transactions_metadata ON transactions USING GIN (metadata);
