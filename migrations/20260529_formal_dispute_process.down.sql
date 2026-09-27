-- Rollback: 20260529_formal_dispute_process
-- Removes the formal dispute process: drops the evidence/timeline tables and
-- the new disputes columns, and restores the CHECK constraints to their
-- pre-migration value sets (transactions includes 'clawed_back' from
-- 20260426_add_clawback_status; disputes reverts to the 002 values).

DROP TABLE IF EXISTS dispute_timeline;
DROP TABLE IF EXISTS dispute_evidence;

ALTER TABLE disputes
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS sla_due_date,
  DROP COLUMN IF EXISTS sla_warning_sent,
  DROP COLUMN IF EXISTS internal_notes;

ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_priority_check;
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_status_check;
ALTER TABLE disputes
  ADD CONSTRAINT disputes_status_check
  CHECK (status IN ('open', 'investigating', 'resolved', 'rejected'));

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled', 'clawed_back'));
