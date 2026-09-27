-- Migration: 20260902_add_transactions_merchant_id (down)

DROP INDEX IF EXISTS idx_transactions_merchant_created;
DROP INDEX IF EXISTS idx_transactions_merchant_id;

ALTER TABLE transactions
  DROP COLUMN IF EXISTS merchant_id;
