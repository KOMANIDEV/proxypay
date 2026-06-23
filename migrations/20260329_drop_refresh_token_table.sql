-- Migration: 20260329_drop_create_refresh_tokens_table
-- Description: Drop refresh_tokens in place of `refresh_token_families`
-- Down migration

DROP TABLE refresh_tokens;
 
