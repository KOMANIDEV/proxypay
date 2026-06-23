-- Migration: 006_add_transaction_webhooks
-- Description: Add webhook delivery tracking fields to transactions

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS webhook_delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending'
CHECK (webhook_delivery_status IN ('pending', 'delivered', 'failed', 'skipped'));

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS webhook_last_attempt_at TIMESTAMP;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS webhook_delivered_at TIMESTAMP;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS webhook_last_error TEXT;
