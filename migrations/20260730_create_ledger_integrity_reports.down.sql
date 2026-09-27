-- Rollback: 20260730_create_ledger_integrity_reports
-- Inverted from 20260730_create_ledger_integrity_reports.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS ledger_integrity_reports;
DROP INDEX IF EXISTS idx_ledger_integrity_reports_checked_at;
