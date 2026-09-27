-- Rollback: 20260423_add_travel_rule_records
-- Inverted from 20260423_add_travel_rule_records.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS travel_rule_records;
DROP INDEX IF EXISTS idx_travel_rule_transaction;
DROP INDEX IF EXISTS idx_travel_rule_created_at;
DROP INDEX IF EXISTS idx_travel_rule_exported;
