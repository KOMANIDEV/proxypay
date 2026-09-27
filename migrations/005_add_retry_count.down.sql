-- Rollback: 005_add_retry_count
-- Inverted from 005_add_retry_count.sql; hand-verified against the up migration.

ALTER TABLE transactions DROP COLUMN IF EXISTS retry_count;
