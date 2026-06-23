-- Migration: Add reference_number column to transactions table
-- Date: 2026-03-23
-- Description: Adds human-readable reference numbers in format TXN-YYYYMMDD-XXXXX

-- Add the reference_number column (nullable initially for existing records)
ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS reference_number VARCHAR(25);

-- Create a function to generate reference numbers for existing records
DO $$
DECLARE
  rec RECORD;
  date_str TEXT;
  seq_num INTEGER;
  ref_num TEXT;
BEGIN
  FOR rec IN SELECT id, created_at FROM transactions WHERE reference_number IS NULL ORDER BY created_at
  LOOP
    -- Format date as YYYYMMDD
    date_str := TO_CHAR(rec.created_at, 'YYYYMMDD');
    
    -- Get next sequence number for this date
    SELECT COALESCE(MAX(CAST(SPLIT_PART(reference_number, '-', 3) AS INTEGER)), 0) + 1
    INTO seq_num
    FROM transactions
    WHERE reference_number LIKE 'TXN-' || date_str || '-%';
    
    -- Generate reference number
    ref_num := 'TXN-' || date_str || '-' || LPAD(seq_num::TEXT, 5, '0');
    
    -- Update the record
    UPDATE transactions SET reference_number = ref_num WHERE id = rec.id;
  END LOOP;
END $$;

-- Make the column NOT NULL and UNIQUE after populating existing records
ALTER TABLE transactions 
ALTER COLUMN reference_number SET NOT NULL;

ALTER TABLE transactions 
ADD CONSTRAINT transactions_reference_number_unique UNIQUE (reference_number);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_transactions_reference_number ON transactions(reference_number);
