DROP INDEX IF EXISTS idx_transactions_phone_search_tokens;

ALTER TABLE transactions
  DROP COLUMN IF EXISTS phone_search_tokens;