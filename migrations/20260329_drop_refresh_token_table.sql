-- Migration: 20260329_drop_refresh_token_table
-- Description: Drop refresh_tokens in place of `refresh_token_families`
--
-- Guarded with IF EXISTS: refresh_tokens was never created by the managed
-- migrations/ chain (only by an earlier unmanaged script in some
-- environments), so a fresh database has nothing to drop.

DROP TABLE IF EXISTS refresh_tokens;
 
