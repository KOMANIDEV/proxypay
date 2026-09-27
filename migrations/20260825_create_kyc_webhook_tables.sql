-- #402 – KYC Webhook Callback System
-- Creates tables for storing webhook delivery state and user webhook configs.

CREATE TABLE IF NOT EXISTS kyc_webhook_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  webhook_url TEXT NOT NULL,
  secret      VARCHAR(255),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  events      TEXT[]  NOT NULL DEFAULT ARRAY[
    'kyc.check.completed',
    'kyc.status.changed',
    'kyc.workflow.completed'
  ],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kyc_webhook_user UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_configs_user_id
  ON kyc_webhook_configs(user_id);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kyc_webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type      VARCHAR(100) NOT NULL,
  event_id        VARCHAR(100) NOT NULL,
  payload         JSONB        NOT NULL,
  target_url      TEXT         NOT NULL,
  attempt_count   INT          NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','delivered','failed','exhausted')),
  http_status     INT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_deliveries_pending
  ON kyc_webhook_deliveries(status, next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_deliveries_user_id
  ON kyc_webhook_deliveries(user_id);

CREATE INDEX IF NOT EXISTS idx_kyc_webhook_deliveries_event_id
  ON kyc_webhook_deliveries(event_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_kyc_webhook_deliveries_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kyc_webhook_deliveries_updated_at ON kyc_webhook_deliveries;
CREATE TRIGGER trg_kyc_webhook_deliveries_updated_at
  BEFORE UPDATE ON kyc_webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_kyc_webhook_deliveries_updated_at();
