-- Rollback: 20260422_add_api_key_permissions
-- The api_keys table is created outside the managed migrations/ chain, so the
-- drops must be guarded: on fresh databases the table does not exist.

DO $$
BEGIN
  IF to_regclass('api_keys') IS NOT NULL THEN
    DROP INDEX IF EXISTS idx_api_keys_permissions;
    ALTER TABLE api_keys DROP COLUMN IF EXISTS label;
    ALTER TABLE api_keys DROP COLUMN IF EXISTS permissions;
  END IF;
END
$$;
