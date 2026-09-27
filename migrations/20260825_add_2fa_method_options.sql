-- #404 – Two-Factor Authentication Method Options
-- Adds tables for multi-method 2FA support (SMS, WebAuthn, backup codes)
-- and extends the users table with primary_2fa_method.

-- 1. Extend users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS primary_2fa_method VARCHAR(20)
    CHECK (primary_2fa_method IN ('totp', 'sms', 'webauthn', 'backup_code'));

-- 2. Per-user 2FA method registry
CREATE TABLE IF NOT EXISTS user_2fa_methods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method      VARCHAR(20) NOT NULL CHECK (method IN ('totp', 'sms', 'webauthn', 'backup_code')),
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  enrolled_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_2fa_method UNIQUE (user_id, method)
);

CREATE INDEX IF NOT EXISTS idx_user_2fa_methods_user_id
  ON user_2fa_methods(user_id);

-- 3. WebAuthn credentials storage
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id       BYTEA NOT NULL,
  public_key          BYTEA NOT NULL,
  aaguid              UUID,
  sign_count          BIGINT NOT NULL DEFAULT 0,
  device_type         VARCHAR(32),    -- 'single_device' | 'multi_device'
  backed_up           BOOLEAN NOT NULL DEFAULT FALSE,
  transports          TEXT[],
  friendly_name       VARCHAR(255),
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_webauthn_credential_id UNIQUE (credential_id)
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id
  ON webauthn_credentials(user_id);

-- 4. WebAuthn pending challenges (used during authentication / registration)
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge   TEXT NOT NULL,
  type        VARCHAR(20) NOT NULL CHECK (type IN ('registration', 'authentication')),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user_id
  ON webauthn_challenges(user_id, type)
  WHERE used = FALSE;

-- 5. Auto-expire challenge cleanup function
CREATE OR REPLACE FUNCTION cleanup_expired_webauthn_challenges()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM webauthn_challenges WHERE expires_at < NOW();
$$;
