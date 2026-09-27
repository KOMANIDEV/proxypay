-- Rollback: 20260601_create_accounting_contact_mappings
-- Inverted from 20260601_create_accounting_contact_mappings.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS accounting_contact_mappings;
DROP INDEX IF EXISTS idx_accounting_contact_mappings_user_id;
DROP INDEX IF EXISTS idx_accounting_contact_mappings_provider_tenant;
