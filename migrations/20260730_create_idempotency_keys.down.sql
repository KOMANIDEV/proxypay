-- Rollback: 20260730_create_idempotency_keys
-- Inverted from 20260730_create_idempotency_keys.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS idempotency_keys;
DROP INDEX IF EXISTS idx_idempotency_keys_expires_at;
