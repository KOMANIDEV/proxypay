-- Rollback: 009_add_push_tokens
-- Inverted from 009_add_push_tokens.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS push_tokens_updated_at ON push_tokens;
DROP TABLE IF EXISTS push_tokens;
DROP INDEX IF EXISTS idx_push_tokens_user_id;
DROP INDEX IF EXISTS idx_push_tokens_token;
DROP INDEX IF EXISTS idx_push_tokens_platform;
DROP INDEX IF EXISTS idx_push_tokens_updated_at;
DROP FUNCTION IF EXISTS update_push_tokens_updated_at;
