-- Add metadata JSONB column to transactions
-- Allows attaching arbitrary key-value data to each transaction
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- GIN index for efficient containment queries (@>)
CREATE INDEX IF NOT EXISTS idx_transactions_metadata ON transactions USING GIN (metadata);
