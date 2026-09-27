-- Rollback: 009_partition_transactions
-- Detaches the legacy table, drops the partitioned parent, and restores the
-- original table name and constraints. Monthly partition tables created after
-- migration are dropped together with the parent.
-- NOTE: no explicit BEGIN/COMMIT — the migration runner wraps each migration
-- in a transaction.

-- Detach the legacy table from the partitioned parent
ALTER TABLE transactions DETACH PARTITION transactions_legacy;

-- Drop the partitioned parent (cascades indexes and its partitions)
DROP TABLE transactions;

-- Restore the original table name
ALTER TABLE transactions_legacy RENAME TO transactions;

-- Restore the constraint names moved aside in Step 2 of the up migration
ALTER TABLE transactions RENAME CONSTRAINT transactions_legacy_type_check TO transactions_type_check;
ALTER TABLE transactions RENAME CONSTRAINT transactions_legacy_status_check TO transactions_status_check;
ALTER TABLE transactions RENAME CONSTRAINT transactions_legacy_webhook_delivery_status_check TO transactions_webhook_delivery_status_check;

-- Restore the PRIMARY KEY and UNIQUE constraints dropped in Step 1
ALTER TABLE transactions ADD PRIMARY KEY (id);
ALTER TABLE transactions ADD CONSTRAINT transactions_reference_number_key UNIQUE (reference_number);

-- Restore the foreign key from disputes dropped in Step 1 (see Step 9 note
-- in the up migration for why it cannot exist while transactions is partitioned)
ALTER TABLE disputes
  ADD CONSTRAINT disputes_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT;

-- Drop the columns that Step 0 of the up migration added to the legacy table
-- (those it did not already have from earlier migrations). The partitioned
-- parent declared them, so the legacy table must lose them again to restore
-- the exact pre-migration schema.
ALTER TABLE transactions DROP COLUMN IF EXISTS notes;
ALTER TABLE transactions DROP COLUMN IF EXISTS admin_notes;
ALTER TABLE transactions DROP COLUMN IF EXISTS currency;
ALTER TABLE transactions DROP COLUMN IF EXISTS original_amount;
ALTER TABLE transactions DROP COLUMN IF EXISTS converted_amount;
ALTER TABLE transactions DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE transactions DROP COLUMN IF EXISTS idempotency_expires_at;
ALTER TABLE transactions DROP COLUMN IF EXISTS location_metadata;
-- vault_id is added by a LATER migration (20260327_add_vaults_support), so it
-- must not survive this rollback.
ALTER TABLE transactions DROP COLUMN IF EXISTS vault_id;

-- Step 0 forced created_at NOT NULL (required for the partition key); restore
-- the nullable state declared by 001_initial_schema.
ALTER TABLE transactions ALTER COLUMN created_at DROP NOT NULL;

-- Drop the index copies PostgreSQL created on the legacy partition when the
-- partitioned parent's indexes were built in Step 7 of the up migration.
-- The copies are auto-named <partition>_<column>_idx and survive the parent
-- drop, so remove them to restore the exact pre-migration schema.
DROP INDEX IF EXISTS transactions_legacy_currency_idx;
DROP INDEX IF EXISTS transactions_legacy_expr_idx;
DROP INDEX IF EXISTS transactions_legacy_idempotency_key_idx;

-- Drop the helper functions
DROP FUNCTION IF EXISTS create_monthly_partition(DATE);
DROP FUNCTION IF EXISTS update_transactions_updated_at();
