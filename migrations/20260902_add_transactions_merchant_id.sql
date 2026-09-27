-- Migration: 20260902_add_transactions_merchant_id
-- Description: Add merchant_id to transactions so multi-merchant installations
--              can filter transaction searches by merchant (issue #621).
--              Historically the transaction owner (`user_id`) *is* the merchant
--              — the same convention used by subscriptions.merchant_id — so
--              existing rows are backfilled from user_id.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS merchant_id UUID;

UPDATE transactions
SET merchant_id = user_id
WHERE merchant_id IS NULL
  AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_merchant_id
  ON transactions(merchant_id);

CREATE INDEX IF NOT EXISTS idx_transactions_merchant_created
  ON transactions(merchant_id, created_at DESC);
