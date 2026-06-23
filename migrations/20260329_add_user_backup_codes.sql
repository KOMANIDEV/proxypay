-- Migration: 20260329_add_backup_codes
-- Description: Add backup_codes column to users table 
-- Up migration

-- 1. Add backup_codes column
ALTER TABLE users
ADD COLUMN IF NOT EXISTS backup_codes VARCHAR(255);

-- 2. Add index
CREATE INDEX IF NOT EXISTS idx_users_backup_codes ON users(backup_codes);
