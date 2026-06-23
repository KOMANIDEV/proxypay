-- Migration: Add notes and admin_notes to transactions
-- Description: Adds columns for user and admin notes with a limit handled in the application layer.
-- Also adds a GIN index for searchability.

ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS notes TEXT,
ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- Index for searching notes (using a simple search index or GIN for better performance if using tsvector)
-- For now, we'll use a standard index or just rely on the TEXT search capabilities.
-- Given the requirement "Make notes searchable", we'll add an index.
CREATE INDEX IF NOT EXISTS idx_transactions_notes_search ON transactions USING GIN (to_tsvector('english', COALESCE(notes, '') || ' ' || COALESCE(admin_notes, '')));
