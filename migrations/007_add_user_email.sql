-- Migration: 007_add_user_email
-- Description: Add email column to users table for notifications
-- Up migration

ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
