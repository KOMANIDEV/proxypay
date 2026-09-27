-- Store keyed suffix digests so phone searches can use an indexed predicate
-- without exposing plaintext phone numbers to the database.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS phone_search_tokens TEXT[];

CREATE INDEX IF NOT EXISTS idx_transactions_phone_search_tokens
  ON transactions USING GIN (phone_search_tokens);