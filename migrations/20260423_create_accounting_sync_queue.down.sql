-- Rollback: 20260423_create_accounting_sync_queue
-- Inverted from 20260423_create_accounting_sync_queue.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS accounting_sync_queue;
DROP INDEX IF EXISTS idx_accounting_sync_queue_status;
DROP INDEX IF EXISTS idx_accounting_sync_queue_transaction;
