-- Rollback: 20260825_create_provider_api_schema_versions
-- Inverted from 20260825_create_provider_api_schema_versions.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS provider_api_schema_versions;
DROP INDEX IF EXISTS idx_provider_schema_latest;
