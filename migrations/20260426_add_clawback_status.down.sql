-- Rollback: 20260426_add_clawback_status
--
-- The up migration only ADDED the 'clawed_back' value to the transactions
-- status CHECK constraint; the original 4-value constraint (renamed
-- transactions_legacy_status_check by 009_partition_transactions) was never
-- removed. Rolling back therefore only needs to drop the added constraint on
-- the partitioned parent — PostgreSQL removes the propagated copies on every
-- partition automatically.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
