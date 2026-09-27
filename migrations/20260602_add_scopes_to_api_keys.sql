-- Issue #936: Add granular scopes column to api_keys table.
-- `scopes` stores the human-readable scope names that correspond to the
-- `permissions` bitmask so queries/admin UI don't need to decode bits.
-- Existing rows default to an empty array; requireAuth will treat them as
-- FULL_ACCESS (backward compatible with the prior DEFAULT 15 on permissions).
--
-- The api_keys table is created outside the managed migrations/ chain, so
-- guard the ALTER: a fresh database without the table must not fail.

DO $$
BEGIN
  IF to_regclass('api_keys') IS NOT NULL THEN
    ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}';

    COMMENT ON COLUMN api_keys.scopes IS
      'Array of ApiKeyScopeName values, kept in sync with permissions bitmask (Issue #936)';
  END IF;
END
$$;

-- Back-fill is intentionally left to the application layer when keys are next
-- rotated or explicitly updated via the admin API.
