-- Rollback: 20260825_create_upload_security_records
-- Inverted from 20260825_create_upload_security_records.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS upload_security_records;
DROP INDEX IF EXISTS idx_upload_security_sha256;
DROP INDEX IF EXISTS idx_upload_security_quarantine;
