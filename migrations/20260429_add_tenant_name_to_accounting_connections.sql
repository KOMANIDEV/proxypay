-- Add tenant_name to accounting_connections for Xero multi-tenant support.
-- Stores the human-readable Xero organization name resolved during the
-- OAuth 2.0 callback so the connected organization can be displayed and
-- multi-tenant selections can be surfaced to the user.
--
-- NOTE: 004_create_accounting_tables already defines tenant_name VARCHAR(200)
-- with an identical definition, so this migration is an idempotent no-op on
-- any database that ran 004. It is kept as a record of the requirement; the
-- down migration is a no-op as well and must NOT drop the column (it predates
-- this migration).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'accounting_connections' AND column_name = 'tenant_name'
    ) THEN
        ALTER TABLE accounting_connections ADD COLUMN tenant_name VARCHAR(200);
    END IF;
END
$$;
