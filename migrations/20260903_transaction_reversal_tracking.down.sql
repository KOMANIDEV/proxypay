-- Rollback: 20260903_transaction_reversal_tracking
-- Drops reversal state tracking and the reversal audit trail.

DROP INDEX IF EXISTS idx_transaction_reversal_events_reversal;
DROP TABLE IF EXISTS transaction_reversal_events;

DROP INDEX IF EXISTS idx_transaction_reversals_reference;
DROP INDEX IF EXISTS idx_transaction_reversals_status;
DROP INDEX IF EXISTS idx_transaction_reversals_transaction;
DROP TABLE IF EXISTS transaction_reversals;
