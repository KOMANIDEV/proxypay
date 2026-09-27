-- Rollback: 20260327_add_vaults_support
-- Drops the vault tables, their indexes/trigger/function, and the
-- idx_transactions_vault_id index.
--
-- transactions.vault_id is deliberately NOT dropped: the column was already
-- declared by 009_partition_transactions (Step 0 column sync), so it exists
-- before this migration and must survive its rollback.

DROP TRIGGER IF EXISTS vaults_updated_at ON vaults;
DROP TABLE IF EXISTS vault_transactions;
DROP TABLE IF EXISTS vaults;
DROP INDEX IF EXISTS idx_vaults_user_id;
DROP INDEX IF EXISTS idx_vaults_user_active;
DROP INDEX IF EXISTS idx_vaults_created_at;
DROP INDEX IF EXISTS idx_vault_transactions_vault_id;
DROP INDEX IF EXISTS idx_vault_transactions_user_id;
DROP INDEX IF EXISTS idx_vault_transactions_created_at;
DROP INDEX IF EXISTS idx_vault_transactions_reference_id;
DROP INDEX IF EXISTS idx_transactions_vault_id;
DROP FUNCTION IF EXISTS update_vaults_updated_at;
