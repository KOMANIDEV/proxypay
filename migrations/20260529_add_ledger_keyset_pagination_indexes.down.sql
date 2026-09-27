-- Rollback: 20260529_add_ledger_keyset_pagination_indexes
-- Inverted from 20260529_add_ledger_keyset_pagination_indexes.sql; hand-verified against the up migration.

DROP INDEX IF EXISTS idx_ledger_entries_account_keyset;
DROP INDEX IF EXISTS idx_ledger_entries_keyset;
