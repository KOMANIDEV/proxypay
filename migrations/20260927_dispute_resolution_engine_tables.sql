-- Migration: 20260927_dispute_resolution_engine_tables
-- Description: Create tables used by the automated dispute resolution engine
--              and add rule_priority tracking to the audit log.
--
-- Creates:
--   dispute_resolution_config         – key/value engine configuration
--   dispute_resolution_rules          – named rules with priority and enabled flag
--   dispute_resolution_log            – per-dispute audit trail (with rule_priority)
--   dispute_resolution_notifications  – pre-resolution merchant notifications

-- ─── dispute_resolution_config ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dispute_resolution_config (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT         NOT NULL,
  description TEXT,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO dispute_resolution_config (key, value, description) VALUES
  ('confidence_threshold',        '0.85', 'Minimum confidence score (0–1) required to auto-resolve a dispute'),
  ('max_transaction_age_hours',   '72',   'Maximum transaction age in hours eligible for auto-resolution'),
  ('amount_mismatch_tolerance_pct', '0.5', 'Percentage tolerance for amount-mismatch checks'),
  ('timeout_threshold_seconds',   '300',  'Seconds before a pending transaction is considered timed out')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION update_dispute_resolution_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dispute_resolution_config_updated_at ON dispute_resolution_config;
CREATE TRIGGER dispute_resolution_config_updated_at
  BEFORE UPDATE ON dispute_resolution_config
  FOR EACH ROW EXECUTE FUNCTION update_dispute_resolution_config_updated_at();

-- ─── dispute_resolution_rules ─────────────────────────────────────────────────
-- Stores the canonical list of named rules and their priorities.
-- The engine uses this table to record rule metadata; actual evaluation logic
-- lives in code.  Operators can disable a rule or adjust its priority here
-- without a code deploy (requires engine restart to re-read).

CREATE TABLE IF NOT EXISTS dispute_resolution_rules (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL UNIQUE,
  -- Higher priority number = evaluated first.  Must be a positive integer.
  priority    INTEGER      NOT NULL CHECK (priority > 0),
  enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
  description TEXT,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed the four built-in rules that ship with the engine.
INSERT INTO dispute_resolution_rules (name, priority, description) VALUES
  ('duplicate_transaction', 40, 'Detects transactions that were processed more than once within a 1-minute window'),
  ('already_refunded',      30, 'Identifies disputes where a refund has already been issued for the transaction'),
  ('provider_timeout',      20, 'Handles disputes on transactions that timed out waiting for a provider response'),
  ('amount_mismatch',       10, 'Flags amount-related disputes on completed transactions for manual review')
ON CONFLICT (name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_dispute_resolution_rules_priority
  ON dispute_resolution_rules (priority DESC)
  WHERE enabled = TRUE;

CREATE OR REPLACE FUNCTION update_dispute_resolution_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dispute_resolution_rules_updated_at ON dispute_resolution_rules;
CREATE TRIGGER dispute_resolution_rules_updated_at
  BEFORE UPDATE ON dispute_resolution_rules
  FOR EACH ROW EXECUTE FUNCTION update_dispute_resolution_rules_updated_at();

-- ─── dispute_resolution_log ───────────────────────────────────────────────────
-- Audit log recording which rule resolved each dispute, at what confidence,
-- and (new) at what priority.

CREATE TABLE IF NOT EXISTS dispute_resolution_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    UUID         NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  rule_name     VARCHAR(100) NOT NULL,
  -- Priority of the rule at the time of resolution (snapshot, not FK).
  rule_priority INTEGER      NOT NULL DEFAULT 0,
  confidence    NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  resolution    VARCHAR(20)  NOT NULL CHECK (resolution IN ('resolved', 'rejected')),
  auto_resolved BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dispute_resolution_log_dispute_id
  ON dispute_resolution_log (dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_resolution_log_rule_name
  ON dispute_resolution_log (rule_name);
CREATE INDEX IF NOT EXISTS idx_dispute_resolution_log_created_at
  ON dispute_resolution_log (created_at);

-- ─── dispute_resolution_notifications ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dispute_resolution_notifications (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  UUID         NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  merchant_id VARCHAR(100) NOT NULL,
  rule_name   VARCHAR(100) NOT NULL,
  resolution  VARCHAR(20)  NOT NULL,
  message     TEXT,
  sent_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dispute_resolution_notif_dispute_id
  ON dispute_resolution_notifications (dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_resolution_notif_merchant_id
  ON dispute_resolution_notifications (merchant_id);
