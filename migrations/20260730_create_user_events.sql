-- Migration: 20260730_create_user_events
-- Description: Create user_events table for event-sourced activity timeline
-- Feature #298 - User Activity Timeline with Event Sourcing

-- Enum-like constraint for event types
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_event_type') THEN
    CREATE TYPE user_event_type AS ENUM (
      -- Auth events
      'user.login',
      'user.logout',
      'user.login_failed',
      'user.2fa_enabled',
      'user.2fa_disabled',
      'user.password_changed',
      'user.account_locked',
      'user.account_unlocked',
      -- Transaction events
      'transaction.deposit_initiated',
      'transaction.deposit_completed',
      'transaction.deposit_failed',
      'transaction.withdraw_initiated',
      'transaction.withdraw_completed',
      'transaction.withdraw_failed',
      'transaction.cancelled',
      'transaction.disputed',
      -- KYC events
      'kyc.submitted',
      'kyc.approved',
      'kyc.rejected',
      'kyc.tier_upgraded',
      'kyc.document_uploaded',
      -- Settings events
      'settings.profile_updated',
      'settings.phone_updated',
      'settings.email_updated',
      'settings.language_changed',
      'settings.notification_preference_changed',
      -- Vault events
      'vault.created',
      'vault.deposited',
      'vault.withdrawn',
      -- API Key events
      'api_key.created',
      'api_key.revoked',
      -- Compliance events
      'compliance.aml_flagged',
      'compliance.sanctions_checked',
      -- Other
      'custom'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS user_events (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type      user_event_type NOT NULL,
  aggregate_type  VARCHAR(50)     NOT NULL DEFAULT 'user',
  aggregate_id    UUID            NOT NULL,
  sequence_number BIGINT          NOT NULL,
  payload         JSONB           NOT NULL DEFAULT '{}',
  metadata        JSONB           NOT NULL DEFAULT '{}',
  ip_address      INET,
  user_agent      TEXT,
  session_id      VARCHAR(255),
  correlation_id  UUID,
  causation_id    UUID,
  occurred_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Enforce immutability: no UPDATE allowed (enforced via trigger)
CREATE OR REPLACE FUNCTION prevent_user_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'user_events rows are immutable and cannot be updated';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_events_immutable ON user_events;
CREATE TRIGGER user_events_immutable
  BEFORE UPDATE ON user_events
  FOR EACH ROW EXECUTE FUNCTION prevent_user_event_update();

-- Auto-increment sequence per aggregate for ordering
CREATE SEQUENCE IF NOT EXISTS user_events_sequence_seq;

-- Unique constraint: one sequence number per aggregate
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_events_aggregate_seq
  ON user_events(aggregate_id, sequence_number);

-- Primary query index: user timeline ordered by time
CREATE INDEX IF NOT EXISTS idx_user_events_user_id_occurred
  ON user_events(user_id, occurred_at DESC);

-- Filter by event type
CREATE INDEX IF NOT EXISTS idx_user_events_event_type
  ON user_events(event_type);

-- Composite for filtered timeline queries
CREATE INDEX IF NOT EXISTS idx_user_events_user_type_occurred
  ON user_events(user_id, event_type, occurred_at DESC);

-- Aggregate replay index
CREATE INDEX IF NOT EXISTS idx_user_events_aggregate_id
  ON user_events(aggregate_id, sequence_number ASC);

-- Correlation tracing
CREATE INDEX IF NOT EXISTS idx_user_events_correlation_id
  ON user_events(correlation_id) WHERE correlation_id IS NOT NULL;

-- Analytics: date-range queries on created_at
CREATE INDEX IF NOT EXISTS idx_user_events_created_at
  ON user_events(created_at DESC);

-- JSONB payload search (GIN for analytics)
CREATE INDEX IF NOT EXISTS idx_user_events_payload_gin
  ON user_events USING GIN (payload);

-- Event snapshots table for efficient replay (avoid replaying from beginning)
CREATE TABLE IF NOT EXISTS user_event_snapshots (
  id              UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aggregate_id    UUID      NOT NULL,
  aggregate_type  VARCHAR(50) NOT NULL DEFAULT 'user',
  last_sequence   BIGINT    NOT NULL,
  state           JSONB     NOT NULL DEFAULT '{}',
  version         INTEGER   NOT NULL DEFAULT 1,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_event_snapshots_aggregate
  ON user_event_snapshots(aggregate_id);

CREATE INDEX IF NOT EXISTS idx_user_event_snapshots_user_id
  ON user_event_snapshots(user_id);

-- Auto-update updated_at on snapshots
CREATE OR REPLACE FUNCTION update_user_event_snapshots_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_event_snapshots_updated_at ON user_event_snapshots;
CREATE TRIGGER user_event_snapshots_updated_at
  BEFORE UPDATE ON user_event_snapshots
  FOR EACH ROW EXECUTE FUNCTION update_user_event_snapshots_updated_at();
