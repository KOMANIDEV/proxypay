-- Rollback: 20260428_create_reconciliation_tables
-- Inverted from 20260428_create_reconciliation_tables.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS reconciliation_discrepancies;
DROP TABLE IF EXISTS reconciliation_reports;
DROP INDEX IF EXISTS idx_recon_reports_provider_date;
DROP INDEX IF EXISTS idx_recon_discrepancies_report_id;
DROP INDEX IF EXISTS idx_recon_discrepancies_status;
DROP TYPE IF EXISTS reconciliation_status;
DROP TYPE IF EXISTS discrepancy_type;
DROP TYPE IF EXISTS review_status;
