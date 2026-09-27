-- Rollback: 20260423_create_double_entry_ledger
-- Inverted from 20260423_create_double_entry_ledger.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS accounts_updated_at ON accounts;
DROP TRIGGER IF EXISTS prevent_ledger_update ON ledger_entries;
DROP TRIGGER IF EXISTS prevent_ledger_delete ON ledger_entries;
DROP MATERIALIZED VIEW IF EXISTS account_balances;
DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS accounts;
DROP INDEX IF EXISTS idx_accounts_code;
DROP INDEX IF EXISTS idx_accounts_type;
DROP INDEX IF EXISTS idx_accounts_parent_id;
DROP INDEX IF EXISTS idx_accounts_is_active;
DROP INDEX IF EXISTS idx_ledger_entries_entry_date;
DROP INDEX IF EXISTS idx_ledger_entries_account_id;
DROP INDEX IF EXISTS idx_ledger_entries_transaction_id;
DROP INDEX IF EXISTS idx_ledger_entries_reference_number;
DROP INDEX IF EXISTS idx_ledger_entries_created_at;
DROP INDEX IF EXISTS idx_ledger_entries_account_date;
DROP INDEX IF EXISTS idx_account_balances_account_id;
DROP INDEX IF EXISTS idx_account_balances_type;
DROP FUNCTION IF EXISTS update_accounts_updated_at;
DROP FUNCTION IF EXISTS prevent_ledger_modification;
DROP FUNCTION IF EXISTS refresh_account_balances;
DROP FUNCTION IF EXISTS post_transaction;
DROP FUNCTION IF EXISTS check_ledger_balance;
DROP FUNCTION IF EXISTS get_trial_balance;
DROP FUNCTION IF EXISTS get_account_balance;
