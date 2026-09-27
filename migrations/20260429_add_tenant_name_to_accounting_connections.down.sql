-- Rollback: 20260429_add_tenant_name_to_accounting_connections
-- No-op migration: tenant_name was created by 004_create_accounting_tables,
-- which predates this migration, so there is nothing to undo. This guard
-- asserts the column (which this migration never created) is still present;
-- if it is missing, something outside the migration chain removed it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'accounting_connections' AND column_name = 'tenant_name'
    ) THEN
        RAISE EXCEPTION 'tenant_name missing during rollback of 20260429 — column was removed outside the migration chain';
    END IF;
END
$$;
