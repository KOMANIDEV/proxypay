-- Rollback: 20260329_drop_refresh_token_table
--
-- refresh_tokens was never created by the managed migrations/ chain (only by
-- an earlier unmanaged script in some environments), so the up migration is a
-- no-op on fresh databases and there is nothing to restore here.
--
-- Environments that had a real refresh_tokens table must restore their
-- original table DDL manually before re-applying this migration's predecessor.

DO $$ BEGIN NULL; END $$;
