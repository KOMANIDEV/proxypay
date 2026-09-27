-- Migration: 20260927_dispute_resolution_engine_tables (DOWN)
-- Rolls back all objects created by the up migration.

DROP TABLE IF EXISTS dispute_resolution_notifications;
DROP TABLE IF EXISTS dispute_resolution_log;
DROP TABLE IF EXISTS dispute_resolution_rules;
DROP TABLE IF EXISTS dispute_resolution_config;

DROP FUNCTION IF EXISTS update_dispute_resolution_config_updated_at();
DROP FUNCTION IF EXISTS update_dispute_resolution_rules_updated_at();
