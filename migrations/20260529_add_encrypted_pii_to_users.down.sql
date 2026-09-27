-- Rollback: 20260529_add_encrypted_pii_to_users
-- Inverted from 20260529_add_encrypted_pii_to_users.sql; hand-verified against the up migration.

ALTER TABLE users DROP COLUMN IF EXISTS first_name;
ALTER TABLE users DROP COLUMN IF EXISTS last_name;
ALTER TABLE users DROP COLUMN IF EXISTS address;
ALTER TABLE users DROP COLUMN IF EXISTS date_of_birth;
ALTER TABLE users DROP COLUMN IF EXISTS id_number;
