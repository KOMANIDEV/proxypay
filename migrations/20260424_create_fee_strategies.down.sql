-- Rollback: 20260424_create_fee_strategies
-- Inverted from 20260424_create_fee_strategies.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS fee_strategies_updated_at ON fee_strategies;
DROP TABLE IF EXISTS fee_strategy_audit;
DROP TABLE IF EXISTS fee_strategies;
DROP INDEX IF EXISTS idx_fee_strategies_active;
DROP INDEX IF EXISTS idx_fee_strategies_scope;
DROP INDEX IF EXISTS idx_fee_strategies_user;
DROP INDEX IF EXISTS idx_fee_strategies_provider;
DROP INDEX IF EXISTS idx_fee_strategies_priority;
DROP INDEX IF EXISTS idx_fee_strategy_audit_strategy_id;
DROP INDEX IF EXISTS idx_fee_strategy_audit_changed_at;
DROP TYPE IF EXISTS fee_strategy_type;
DROP TYPE IF EXISTS fee_strategy_scope;
DROP FUNCTION IF EXISTS update_fee_strategies_updated_at;
