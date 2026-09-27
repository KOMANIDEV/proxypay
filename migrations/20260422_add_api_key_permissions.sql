-- Issue #518: Add permissions bitmask to api_keys table
-- Default 15 (0x0F) = ALL permissions for backward compatibility
-- Bit values: READ=1, DEPOSIT=2, WITHDRAW=4, ADMIN=8
--
-- The api_keys table is created outside the managed migrations/ chain, so
-- guard the ALTERs: a fresh database without the table must not fail.

DO $$
BEGIN
  IF to_regclass('api_keys') IS NOT NULL THEN
    ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS permissions INTEGER NOT NULL DEFAULT 15;

    -- Optional label for key management UI
    ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS label VARCHAR(255);

    -- Index for quick permission filtering in admin queries
    CREATE INDEX IF NOT EXISTS idx_api_keys_permissions ON api_keys (permissions);

    COMMENT ON COLUMN api_keys.permissions IS 'Bitmask: READ=1, DEPOSIT=2, WITHDRAW=4, ADMIN=8, ALL=15';
    COMMENT ON COLUMN api_keys.label IS 'Human-readable label for key management UI';
  END IF;
END
$$;
