-- Rollback: 008_add_user_contacts
-- Inverted from 008_add_user_contacts.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS user_contacts_updated_at ON user_contacts;
DROP TABLE IF EXISTS user_contacts;
DROP INDEX IF EXISTS idx_user_contacts_user_id;
DROP FUNCTION IF EXISTS update_user_contacts_updated_at;
