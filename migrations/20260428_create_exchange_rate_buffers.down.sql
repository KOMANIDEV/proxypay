-- Rollback: 20260428_create_exchange_rate_buffers
-- Inverted from 20260428_create_exchange_rate_buffers.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS erb_updated_at ON exchange_rate_buffers;
DROP TABLE IF EXISTS exchange_rate_buffer_audit;
DROP TABLE IF EXISTS exchange_rate_buffers;
DROP INDEX IF EXISTS idx_erb_provider_pair;
DROP INDEX IF EXISTS idx_erb_active;
DROP INDEX IF EXISTS idx_erb_audit_buffer_id;
DROP FUNCTION IF EXISTS update_erb_updated_at;
