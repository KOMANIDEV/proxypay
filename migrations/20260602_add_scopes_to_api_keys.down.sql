-- Rollback: 20260602_add_scopes_to_api_keys
-- The api_keys table is created outside the managed migrations/ chain, so the
-- drop must be guarded: on fresh databases the table does not exist.

DO $$
BEGIN
  IF to_regclass('api_keys') IS NOT NULL THEN
    ALTER TABLE api_keys DROP COLUMN IF EXISTS scopes;
  END IF;
END
$$;
