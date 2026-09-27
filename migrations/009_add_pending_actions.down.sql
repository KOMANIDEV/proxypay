-- Rollback: 009_add_pending_actions
-- Inverted from 009_add_pending_actions.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS pending_actions;
DROP INDEX IF EXISTS idx_pending_actions_status;
DROP INDEX IF EXISTS idx_pending_actions_maker_id;
DROP INDEX IF EXISTS idx_pending_actions_checker_id;
DROP INDEX IF EXISTS idx_pending_actions_type;
