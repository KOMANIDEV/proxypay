-- Rollback: 20260425_add_transaction_indexes
-- Drops only the indexes this migration actually created. idx_transactions_
-- idempotency_key is deliberately NOT dropped: it was created earlier by
-- 009_partition_transactions. The aml_alerts / aml_alert_review_history
-- tables are created by legacy scripts outside the chain, so their indexes
-- are dropped conditionally.

DROP INDEX IF EXISTS idx_transactions_provider;
DROP INDEX IF EXISTS idx_transactions_status_created_at;
DROP INDEX IF EXISTS idx_transactions_notes_fts;
DROP INDEX IF EXISTS idx_transactions_phone_number;
DROP INDEX IF EXISTS idx_transactions_status_created_covering;
DROP INDEX IF EXISTS idx_transactions_idempotency_expires_at;

DO $$
BEGIN
  IF to_regclass('aml_alerts') IS NOT NULL THEN
    DROP INDEX IF EXISTS idx_aml_alerts_status;
    DROP INDEX IF EXISTS idx_aml_alerts_user_id;
    DROP INDEX IF EXISTS idx_aml_alerts_transaction_id;
    DROP INDEX IF EXISTS idx_aml_alerts_severity;
    DROP INDEX IF EXISTS idx_aml_alerts_status_created;
    DROP INDEX IF EXISTS idx_aml_alerts_user_status;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('aml_alert_review_history') IS NOT NULL THEN
    DROP INDEX IF EXISTS idx_aml_review_history_alert_id;
    DROP INDEX IF EXISTS idx_aml_review_history_created_at;
  END IF;
END
$$;
