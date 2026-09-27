-- Rollback: 20260730_create_feature_flags
-- Inverted from 20260730_create_feature_flags.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS trg_feature_flags_updated_at ON feature_flags;
DROP TRIGGER IF EXISTS trg_ff_user_overrides_updated_at ON feature_flag_user_overrides;
DROP TRIGGER IF EXISTS trg_ff_org_overrides_updated_at ON feature_flag_org_overrides;
DROP TABLE IF EXISTS feature_flag_evaluations;
DROP TABLE IF EXISTS feature_flag_audit_log;
DROP TABLE IF EXISTS feature_flag_org_overrides;
DROP TABLE IF EXISTS feature_flag_user_overrides;
DROP TABLE IF EXISTS feature_flags;
DROP INDEX IF EXISTS idx_feature_flags_key;
DROP INDEX IF EXISTS idx_feature_flags_environment;
DROP INDEX IF EXISTS idx_feature_flags_enabled;
DROP INDEX IF EXISTS idx_feature_flags_expires_at;
DROP INDEX IF EXISTS idx_ff_user_overrides_user_id;
DROP INDEX IF EXISTS idx_ff_org_overrides_org_id;
DROP INDEX IF EXISTS idx_ff_audit_log_flag_id;
DROP INDEX IF EXISTS idx_ff_audit_log_created_at;
DROP INDEX IF EXISTS idx_ff_evaluations_flag_id_evaluated_at;
DROP INDEX IF EXISTS idx_ff_evaluations_user_id;
DROP INDEX IF EXISTS idx_ff_evaluations_flag_key;
DROP FUNCTION IF EXISTS update_feature_flag_updated_at;
