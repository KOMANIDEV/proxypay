-- Rollback: 008_add_fee_configurations
-- Inverted from 008_add_fee_configurations.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS fee_configurations_updated_at ON fee_configurations;
DROP TABLE IF EXISTS fee_configuration_audit;
DROP TABLE IF EXISTS fee_configurations;
DROP INDEX IF EXISTS idx_fee_configurations_name;
DROP INDEX IF EXISTS idx_fee_configurations_active;
DROP INDEX IF EXISTS idx_fee_configurations_created_at;
DROP INDEX IF EXISTS idx_fee_audit_config_id;
DROP INDEX IF EXISTS idx_fee_audit_changed_at;
DROP INDEX IF EXISTS idx_fee_audit_changed_by;
DROP FUNCTION IF EXISTS update_fee_configurations_updated_at;
