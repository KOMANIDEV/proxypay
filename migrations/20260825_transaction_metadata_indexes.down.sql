-- Rollback: 20260825_transaction_metadata_indexes
-- Inverted from 20260825_transaction_metadata_indexes.sql; hand-verified against the up migration.

DROP VIEW IF EXISTS v_metadata_index_usage;
ALTER TABLE transactions DROP COLUMN IF EXISTS metadata_tsv;
DROP INDEX IF EXISTS idx_txn_meta_provider;
DROP INDEX IF EXISTS idx_txn_meta_channel;
DROP INDEX IF EXISTS idx_txn_meta_source_country;
DROP INDEX IF EXISTS idx_txn_meta_destination_country;
DROP INDEX IF EXISTS idx_txn_meta_reference;
DROP INDEX IF EXISTS idx_txn_meta_customer_id;
DROP INDEX IF EXISTS idx_txn_metadata_fts;
DROP INDEX IF EXISTS idx_txn_status_meta;
DROP INDEX IF EXISTS idx_txn_has_metadata;
DROP FUNCTION IF EXISTS jsonb_to_text;
