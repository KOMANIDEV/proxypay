-- Rollback: 20260825_create_preference_change_log
-- Inverted from 20260825_create_preference_change_log.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS preference_change_log;
DROP INDEX IF EXISTS idx_preference_change_log_user;
