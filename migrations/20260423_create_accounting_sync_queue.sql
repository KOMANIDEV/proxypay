-- Migration: create accounting_sync_queue
-- Tracks per-transaction sync status for each accounting connection.

CREATE TABLE IF NOT EXISTS accounting_sync_queue (
  id               SERIAL PRIMARY KEY,
  transaction_id   UUID        NOT NULL,
  connection_id    UUID        NOT NULL REFERENCES accounting_connections(id) ON DELETE CASCADE,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'synced', 'failed')),
  error_message    TEXT,
  synced_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_accounting_sync_queue UNIQUE (transaction_id, connection_id)
);

CREATE INDEX IF NOT EXISTS idx_accounting_sync_queue_status
  ON accounting_sync_queue (status);

CREATE INDEX IF NOT EXISTS idx_accounting_sync_queue_transaction
  ON accounting_sync_queue (transaction_id);
