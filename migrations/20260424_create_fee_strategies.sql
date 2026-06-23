-- Migration: 20260424_create_fee_strategies
-- Description: Dynamic Fee Strategy Engine — supports flat, percentage, time-based,
--              and volume-based strategies with user/provider/global priority hierarchy.

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: strategy type
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE fee_strategy_type AS ENUM (
    'flat',        -- Fixed fee amount regardless of transaction size
    'percentage',  -- Percentage of transaction amount
    'time_based',  -- Overrides another strategy during a time window
    'volume_based' -- Tiered fee based on transaction amount brackets
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM: strategy scope (priority hierarchy)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE fee_strategy_scope AS ENUM (
    'user',     -- Applies to a specific user (highest priority)
    'provider', -- Applies to a specific mobile money provider
    'global'    -- Default fallback (lowest priority)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: fee_strategies
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fee_strategies (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100)      NOT NULL,
  description     TEXT,

  -- Strategy classification
  strategy_type   fee_strategy_type NOT NULL,
  scope           fee_strategy_scope NOT NULL DEFAULT 'global',

  -- Scope targets (NULL = applies to all)
  user_id         UUID              REFERENCES users(id) ON DELETE CASCADE,
  provider        VARCHAR(100),     -- e.g. 'orange', 'mtn', 'airtel'

  -- Priority within the same scope (lower number = higher priority)
  priority        INTEGER           NOT NULL DEFAULT 100,

  -- Lifecycle
  is_active       BOOLEAN           NOT NULL DEFAULT true,

  -- ── Flat fee params ──────────────────────────────────────────────────────
  flat_amount     DECIMAL(20,7),    -- Fixed fee in base currency

  -- ── Percentage fee params ────────────────────────────────────────────────
  fee_percentage  DECIMAL(8,4),     -- e.g. 1.5 = 1.5%
  fee_minimum     DECIMAL(20,7),    -- Minimum fee after percentage calc
  fee_maximum     DECIMAL(20,7),    -- Maximum fee after percentage calc

  -- ── Time-based condition params ──────────────────────────────────────────
  -- days_of_week: JSON array of ISO weekday numbers (1=Mon … 7=Sun)
  -- e.g. [5] = Fridays only, [6,7] = weekends
  days_of_week    JSONB,
  -- time_start / time_end: 'HH:MM' in UTC, NULL = all day
  time_start      TIME,
  time_end        TIME,
  -- When time condition matches, override_percentage is applied instead
  -- (NULL means 0% fee — i.e. fee-free)
  override_percentage DECIMAL(8,4),
  override_flat_amount DECIMAL(20,7),

  -- ── Volume-based condition params ────────────────────────────────────────
  -- volume_tiers: JSON array of { minAmount, maxAmount, feePercentage, flatAmount }
  -- Tiers are evaluated in order; first matching bracket wins.
  -- Example: [{"minAmount":0,"maxAmount":100000,"feePercentage":1.5},
  --           {"minAmount":100000,"maxAmount":null,"feePercentage":0.8}]
  volume_tiers    JSONB,

  -- ── Audit ────────────────────────────────────────────────────────────────
  created_by      UUID              NOT NULL REFERENCES users(id),
  updated_by      UUID              NOT NULL REFERENCES users(id),
  created_at      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Constraints
  CONSTRAINT chk_scope_user     CHECK (scope != 'user'     OR user_id IS NOT NULL),
  CONSTRAINT chk_scope_provider CHECK (scope != 'provider' OR provider IS NOT NULL),
  CONSTRAINT chk_flat_amount    CHECK (strategy_type != 'flat'       OR flat_amount IS NOT NULL),
  CONSTRAINT chk_pct_amount     CHECK (strategy_type != 'percentage' OR fee_percentage IS NOT NULL),
  CONSTRAINT chk_time_days      CHECK (strategy_type != 'time_based' OR days_of_week IS NOT NULL),
  CONSTRAINT chk_volume_tiers   CHECK (strategy_type != 'volume_based' OR volume_tiers IS NOT NULL),
  CONSTRAINT chk_priority_pos   CHECK (priority >= 0)
);

-- Indexes for fast resolution lookups
CREATE INDEX IF NOT EXISTS idx_fee_strategies_active
  ON fee_strategies(is_active);
CREATE INDEX IF NOT EXISTS idx_fee_strategies_scope
  ON fee_strategies(scope, is_active);
CREATE INDEX IF NOT EXISTS idx_fee_strategies_user
  ON fee_strategies(user_id, is_active)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fee_strategies_provider
  ON fee_strategies(provider, is_active)
  WHERE provider IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fee_strategies_priority
  ON fee_strategies(scope, priority, is_active);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_fee_strategies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fee_strategies_updated_at ON fee_strategies;
CREATE TRIGGER fee_strategies_updated_at
  BEFORE UPDATE ON fee_strategies
  FOR EACH ROW EXECUTE FUNCTION update_fee_strategies_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: fee_strategy_audit
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fee_strategy_audit (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id     UUID        NOT NULL REFERENCES fee_strategies(id) ON DELETE CASCADE,
  action          VARCHAR(20) NOT NULL CHECK (action IN ('CREATE','UPDATE','DELETE','ACTIVATE','DEACTIVATE')),
  old_values      JSONB,
  new_values      JSONB,
  changed_by      UUID        NOT NULL REFERENCES users(id),
  changed_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address      INET,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_fee_strategy_audit_strategy_id
  ON fee_strategy_audit(strategy_id);
CREATE INDEX IF NOT EXISTS idx_fee_strategy_audit_changed_at
  ON fee_strategy_audit(changed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED: example "Fee-free Fridays" strategy (global, time-based)
-- Requires a system user to exist; adjust the UUID as needed.
-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT INTO fee_strategies (
--   name, description, strategy_type, scope, priority,
--   days_of_week, override_percentage,
--   created_by, updated_by
-- ) VALUES (
--   'Fee-free Fridays',
--   'Zero-fee promotion every Friday — configured by marketing team',
--   'time_based', 'global', 10,
--   '[5]', 0,
--   '<system-user-uuid>', '<system-user-uuid>'
-- );
