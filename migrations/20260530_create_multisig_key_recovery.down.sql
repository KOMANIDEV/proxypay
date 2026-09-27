-- Rollback: 20260530_create_multisig_key_recovery
-- Drops the managed keys / recovery tables, triggers, and the
-- recovery_session_state type.
--
-- update_updated_at_column() is deliberately NOT dropped: it was created
-- earlier by 004_create_accounting_tables, which this migration only
-- re-created with an identical body.

DROP TRIGGER IF EXISTS managed_keys_updated_at ON managed_keys;
DROP TRIGGER IF EXISTS key_recovery_sessions_updated_at ON key_recovery_sessions;

DROP TABLE IF EXISTS key_recovery_audit_log;
DROP TABLE IF EXISTS key_recovery_sessions;
DROP TABLE IF EXISTS recovery_tokens;
DROP TABLE IF EXISTS recovery_signers;
DROP TABLE IF EXISTS managed_keys;

DROP TYPE IF EXISTS recovery_session_state;
