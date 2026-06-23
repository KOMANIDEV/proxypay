ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(255);