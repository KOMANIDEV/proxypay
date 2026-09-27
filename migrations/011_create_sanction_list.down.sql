-- Rollback: 011_create_sanction_list
-- Inverted from 011_create_sanction_list.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS sanction_list_updated_at ON sanction_list;
DROP TABLE IF EXISTS sanction_list;
DROP INDEX IF EXISTS idx_sanction_list_name;
DROP INDEX IF EXISTS idx_sanction_list_external_id;
DROP FUNCTION IF EXISTS update_sanction_list_updated_at;
