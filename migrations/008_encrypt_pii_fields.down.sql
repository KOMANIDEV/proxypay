-- Rollback: 008_encrypt_pii_fields
--
-- Restores the column types widened for encrypted PII back to their
-- pre-migration declared sizes (from 001_initial_schema and
-- 003_add_2fa_support). The DO-block sections of the up migration were
-- no-ops on the ordered chain (notes/admin_notes did not exist yet), so only
-- the five ALTER COLUMN statements need to be reversed.

ALTER TABLE transactions ALTER COLUMN phone_number TYPE VARCHAR(20);
ALTER TABLE transactions ALTER COLUMN stellar_address TYPE VARCHAR(56);

ALTER TABLE users ALTER COLUMN phone_number TYPE VARCHAR(20);
ALTER TABLE users ALTER COLUMN email TYPE VARCHAR(255);
ALTER TABLE users ALTER COLUMN two_factor_secret TYPE VARCHAR(32);
