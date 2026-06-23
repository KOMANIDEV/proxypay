-- Migration: add_currency_to_transactions
-- Adds multi-currency support to the transactions table.
-- Stores the original currency and amount alongside the USD-converted amount,
-- allowing accurate reporting regardless of input currency.

-- Currency code of the original transaction (ISO 4217, 3-char)
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';

-- Amount in the original currency (same value as `amount` for existing rows)
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS original_amount DECIMAL(20, 7);

-- Amount expressed in the base currency (USD) for uniform aggregation
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS converted_amount DECIMAL(20, 7);

-- Back-fill: existing rows already have USD amounts stored in `amount`
UPDATE transactions
SET original_amount  = amount,
    converted_amount = amount
WHERE original_amount IS NULL;

-- Index to allow filtering/grouping by currency efficiently
CREATE INDEX IF NOT EXISTS idx_transactions_currency ON transactions(currency);
