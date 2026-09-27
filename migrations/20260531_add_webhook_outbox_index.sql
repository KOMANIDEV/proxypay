-- Migration: 20260531_add_webhook_outbox_index
-- Description: Add missing index on webhook_outbox (status, next_attempt_at)
--              to speed up worker scans for pending webhooks.
--
-- NOTE: 010_webhook_outbox already creates idx_webhook_outbox_status_next_retry
-- with an identical definition, so this migration is an idempotent no-op on
-- any database that ran 010. The down migration must NOT drop the index (it
-- predates this migration); it asserts the index is still present instead.

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_status_next_retry
  ON webhook_outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
