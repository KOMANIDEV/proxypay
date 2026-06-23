-- SEP-02 Federation Server: add username and hash columns to users table
--
-- username:    plaintext federation handle (e.g. "alice" → "alice*domain.com")
-- phone_hash:  SHA-256 of the normalised phone number for indexed lookups
--              (avoids full-table decryption scans)
-- email_hash:  SHA-256 of the lowercased email for indexed lookups

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username    VARCHAR(50)  UNIQUE,
  ADD COLUMN IF NOT EXISTS phone_hash  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS email_hash  VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_users_username   ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_hash);
CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash);

COMMENT ON COLUMN users.username   IS 'Optional federation handle; becomes the local part of user*domain.com';
COMMENT ON COLUMN users.phone_hash IS 'SHA-256 of the normalised phone number for O(1) federation lookups';
COMMENT ON COLUMN users.email_hash IS 'SHA-256 of the lowercased email for O(1) federation lookups';
