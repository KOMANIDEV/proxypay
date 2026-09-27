-- Rollback: 20260902_provider_api_version_management
-- Drops provider API version management in reverse dependency order.

DROP INDEX IF EXISTS idx_provider_api_version_events_recent;
DROP TABLE IF EXISTS provider_api_version_events;

DROP TABLE IF EXISTS provider_api_version_compat;

DROP INDEX IF EXISTS idx_provider_api_versions_lookup;
DROP TABLE IF EXISTS provider_api_versions;
