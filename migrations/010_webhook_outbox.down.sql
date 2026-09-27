-- Rollback: 010_webhook_outbox
-- Inverted from 010_webhook_outbox.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS webhook_outbox;
DROP INDEX IF EXISTS idx_webhook_outbox_status_next_retry;
