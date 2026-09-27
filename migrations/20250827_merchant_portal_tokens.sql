-- Migration: Create merchant_portal_tokens table
-- Supports one-time-use portal URL generation (#460)

CREATE TABLE IF NOT EXISTS merchant_portal_tokens (
  token_id    TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_portal_tokens_merchant
  ON merchant_portal_tokens (merchant_id);

CREATE INDEX IF NOT EXISTS idx_merchant_portal_tokens_expires
  ON merchant_portal_tokens (expires_at)
  WHERE used = false;

-- Auto-cleanup expired tokens (runs daily via pg_cron or application cron)
-- DELETE FROM merchant_portal_tokens WHERE expires_at < NOW() - INTERVAL '7 days';
