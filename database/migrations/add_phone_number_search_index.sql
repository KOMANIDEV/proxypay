-- Add B-tree index on transactions.phone_number for efficient phone number search
CREATE INDEX IF NOT EXISTS idx_transactions_phone_number ON transactions(phone_number);
