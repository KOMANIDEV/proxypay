-- Rollback: 20260730_create_user_events
-- Inverted from 20260730_create_user_events.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS user_events_immutable ON user_events;
DROP TRIGGER IF EXISTS user_event_snapshots_updated_at ON user_event_snapshots;
DROP TABLE IF EXISTS user_event_snapshots;
DROP TABLE IF EXISTS user_events;
DROP INDEX IF EXISTS idx_user_events_aggregate_seq;
DROP INDEX IF EXISTS idx_user_events_user_id_occurred;
DROP INDEX IF EXISTS idx_user_events_event_type;
DROP INDEX IF EXISTS idx_user_events_user_type_occurred;
DROP INDEX IF EXISTS idx_user_events_aggregate_id;
DROP INDEX IF EXISTS idx_user_events_correlation_id;
DROP INDEX IF EXISTS idx_user_events_created_at;
DROP INDEX IF EXISTS idx_user_events_payload_gin;
DROP INDEX IF EXISTS idx_user_event_snapshots_aggregate;
DROP INDEX IF EXISTS idx_user_event_snapshots_user_id;
DROP SEQUENCE IF EXISTS user_events_sequence_seq;
DROP TYPE IF EXISTS user_event_type;
DROP FUNCTION IF EXISTS prevent_user_event_update;
DROP FUNCTION IF EXISTS update_user_event_snapshots_updated_at;
