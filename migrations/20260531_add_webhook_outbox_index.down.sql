-- Rollback: 20260531_add_webhook_outbox_index
-- No-op migration: the index was created by 010_webhook_outbox, which
-- predates this migration, so there is nothing to undo. This guard asserts
-- the index (which this migration never created) is still present; if it is
-- missing, something outside the migration chain dropped it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_webhook_outbox_status_next_retry'
    ) THEN
        RAISE EXCEPTION 'idx_webhook_outbox_status_next_retry missing during rollback of 20260531 — index was dropped outside the migration chain';
    END IF;
END
$$;
