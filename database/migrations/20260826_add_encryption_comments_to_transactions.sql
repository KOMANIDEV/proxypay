-- Migration: Add encryption documentation comments to transaction sensitive fields
-- This migration documents which columns contain encrypted data for audit and compliance purposes.
--
-- The following columns in the transactions table contain AES-256-GCM encrypted data:
--   - phone_number: User's mobile money phone number
--   - stellar_address: User's Stellar blockchain address
--   - notes: User-provided transaction notes
--   - admin_notes: Internal admin notes
--
-- Encryption format: <iv_hex>:<authTag_hex>:<ciphertext_hex> (legacy)
-- Or versioned: <version>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
--
-- Rollback: DROP the comments (they don't affect data)

-- Document encrypted columns in transactions table
COMMENT ON COLUMN transactions.phone_number IS 'AES-256-GCM encrypted mobile money phone number (iv:authTag:ciphertext hex). Never store in plaintext.';
COMMENT ON COLUMN transactions.stellar_address IS 'AES-256-GCM encrypted Stellar blockchain address (iv:authTag:ciphertext hex). Never store in plaintext.';

-- Add notes and admin_notes columns if they don't exist (they may have been added separately)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS admin_notes TEXT;

COMMENT ON COLUMN transactions.notes IS 'AES-256-GCM encrypted user-provided transaction notes (iv:authTag:ciphertext hex). Optional field.';
COMMENT ON COLUMN transactions.admin_notes IS 'AES-256-GCM encrypted internal admin notes (iv:authTag:ciphertext hex). Optional field.';

-- Document encrypted columns in users table
COMMENT ON COLUMN users.phone_number IS 'AES-256-GCM encrypted phone number (iv:authTag:ciphertext hex). Used for lookups with deterministic encryption.';

-- Add encrypted PII columns to users if they don't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;

COMMENT ON COLUMN users.email IS 'AES-256-GCM encrypted email address (iv:authTag:ciphertext hex).';
COMMENT ON COLUMN users.first_name IS 'AES-256-GCM encrypted first name (iv:authTag:ciphertext hex). Requires authorization to access.';
COMMENT ON COLUMN users.last_name IS 'AES-256-GCM encrypted last name (iv:authTag:ciphertext hex). Requires authorization to access.';
COMMENT ON COLUMN users.address IS 'AES-256-GCM encrypted residential address (iv:authTag:ciphertext hex). Requires authorization to access.';
COMMENT ON COLUMN users.date_of_birth IS 'AES-256-GCM encrypted date of birth (iv:authTag:ciphertext hex). Requires authorization to access.';
COMMENT ON COLUMN users.id_number IS 'AES-256-GCM encrypted government ID number (iv:authTag:ciphertext hex). Requires authorization to access.';
COMMENT ON COLUMN users.two_factor_secret IS 'AES-256-GCM encrypted 2FA TOTP secret (iv:authTag:ciphertext hex). Never expose via API.';

-- Create index for authorized PII access (optional, for queries that need to decrypt)
-- This index is on the raw encrypted data, useful for existence checks
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
