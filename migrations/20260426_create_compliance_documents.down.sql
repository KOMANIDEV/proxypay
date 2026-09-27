-- Rollback: 20260426_create_compliance_documents
-- Inverted from 20260426_create_compliance_documents.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS compliance_documents;
DROP INDEX IF EXISTS idx_compliance_documents_country_code;
DROP INDEX IF EXISTS idx_compliance_documents_provider;
DROP INDEX IF EXISTS idx_compliance_documents_status;
DROP INDEX IF EXISTS idx_compliance_documents_created_at;
DROP INDEX IF EXISTS idx_compliance_documents_tags;
