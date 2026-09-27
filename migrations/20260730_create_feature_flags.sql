-- Migration: create feature_flags system
-- Implements Feature #293 - Feature Flags with Remote Configuration
-- Supports: per-user/org access, gradual rollout, canary deployments,
--           change tracking, and analytics.

-- ─────────────────────────────────────────────
-- Core feature flags table
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key             VARCHAR(128) NOT NULL UNIQUE,
  name            VARCHAR(256) NOT NULL,
  description     TEXT,
  enabled         BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Rollout strategy: 'boolean' | 'percentage' | 'user_list' | 'org_list' | 'canary'
  strategy        VARCHAR(32) NOT NULL DEFAULT 'boolean'
                  CHECK (strategy IN ('boolean', 'percentage', 'user_list', 'org_list', 'canary')),

  -- For percentage / canary rollouts (0–100)
  rollout_percentage NUMERIC(5,2) CHECK (rollout_percentage BETWEEN 0 AND 100),

  -- JSONB payload for complex strategies and metadata
  -- e.g. { "userIds": [...], "orgIds": [...], "regions": [...], "metadata": {...} }
  config          JSONB       NOT NULL DEFAULT '{}',

  -- Optional environment scope: 'all' | 'development' | 'staging' | 'production'
  environment     VARCHAR(32) NOT NULL DEFAULT 'all',

  -- Lifecycle
  expires_at      TIMESTAMP WITH TIME ZONE,
  created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────
-- Per-user feature flag overrides
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flag_user_overrides (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id         UUID        NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled         BOOLEAN     NOT NULL,
  reason          TEXT,
  created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (flag_id, user_id)
);

-- ─────────────────────────────────────────────
-- Per-organisation feature flag overrides
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flag_org_overrides (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id         UUID        NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  org_id          VARCHAR(128) NOT NULL,   -- flexible: merchant id, tenant id, etc.
  enabled         BOOLEAN     NOT NULL,
  reason          TEXT,
  created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (flag_id, org_id)
);

-- ─────────────────────────────────────────────
-- Immutable audit / change history
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flag_audit_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id         UUID        NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  action          VARCHAR(32) NOT NULL
                  CHECK (action IN (
                    'created', 'updated', 'enabled', 'disabled',
                    'user_override_set', 'user_override_removed',
                    'org_override_set',  'org_override_removed',
                    'expired', 'deleted'
                  )),
  actor_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  actor_role      VARCHAR(64),
  previous_state  JSONB,
  new_state       JSONB,
  ip_address      VARCHAR(45),
  user_agent      TEXT,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────
-- Analytics / evaluation events
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flag_evaluations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id         UUID        NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  flag_key        VARCHAR(128) NOT NULL,  -- denormalised for fast aggregation
  user_id         UUID,                   -- nullable for anonymous evaluations
  org_id          VARCHAR(128),
  result          BOOLEAN     NOT NULL,
  strategy_used   VARCHAR(32) NOT NULL,
  context         JSONB       NOT NULL DEFAULT '{}',
  evaluated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_feature_flags_key
  ON feature_flags (key);

CREATE INDEX IF NOT EXISTS idx_feature_flags_environment
  ON feature_flags (environment);

CREATE INDEX IF NOT EXISTS idx_feature_flags_enabled
  ON feature_flags (enabled);

CREATE INDEX IF NOT EXISTS idx_feature_flags_expires_at
  ON feature_flags (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ff_user_overrides_user_id
  ON feature_flag_user_overrides (user_id);

CREATE INDEX IF NOT EXISTS idx_ff_org_overrides_org_id
  ON feature_flag_org_overrides (org_id);

CREATE INDEX IF NOT EXISTS idx_ff_audit_log_flag_id
  ON feature_flag_audit_log (flag_id);

CREATE INDEX IF NOT EXISTS idx_ff_audit_log_created_at
  ON feature_flag_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ff_evaluations_flag_id_evaluated_at
  ON feature_flag_evaluations (flag_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ff_evaluations_user_id
  ON feature_flag_evaluations (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ff_evaluations_flag_key
  ON feature_flag_evaluations (flag_key);

-- ─────────────────────────────────────────────
-- updated_at trigger helper
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_feature_flag_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_feature_flags_updated_at
  BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION update_feature_flag_updated_at();

CREATE TRIGGER trg_ff_user_overrides_updated_at
  BEFORE UPDATE ON feature_flag_user_overrides
  FOR EACH ROW EXECUTE FUNCTION update_feature_flag_updated_at();

CREATE TRIGGER trg_ff_org_overrides_updated_at
  BEFORE UPDATE ON feature_flag_org_overrides
  FOR EACH ROW EXECUTE FUNCTION update_feature_flag_updated_at();
