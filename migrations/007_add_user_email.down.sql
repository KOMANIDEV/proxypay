-- Rollback: 007_add_user_email
--
-- The email column and the idx_users_email index were already created by
-- 003_add_2fa_support, so this migration is a no-op when the chain is applied
-- in order and there is nothing to undo.
--
-- For databases where 003 never ran (legacy environments), this migration
-- would have created a plain (non-partial) idx_users_email index; drop only
-- that variant so 003's partial index is preserved.

DO $$
BEGIN
  IF to_regclass('users') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'idx_users_email'
      AND indexdef NOT ILIKE '% WHERE %'
  ) THEN
    DROP INDEX idx_users_email;
  END IF;
END
$$;
