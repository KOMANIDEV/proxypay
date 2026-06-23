-- Migration: create historical_prices table
-- Stores hourly price snapshots for currency pairs (XLM/USD, USD/XAF, XLM/XAF).
-- Populated by the hourly price-ticker cron job. Used to compute "value at
-- time of transaction" for accurate portfolio valuation over time.

CREATE TABLE IF NOT EXISTS historical_prices (
  id              BIGSERIAL PRIMARY KEY,
  base_currency   VARCHAR(8) NOT NULL,
  quote_currency  VARCHAR(8) NOT NULL,
  price           DECIMAL(20, 8) NOT NULL,
  source          VARCHAR(32) NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT historical_prices_pair_hour_unique
    UNIQUE (base_currency, quote_currency, recorded_at),
  CONSTRAINT historical_prices_price_positive
    CHECK (price > 0)
);

-- Primary lookup: fetch latest or range for a given pair (DESC on recorded_at).
CREATE INDEX IF NOT EXISTS idx_historical_prices_pair_time
  ON historical_prices (base_currency, quote_currency, recorded_at DESC);

-- Supports "value at time T" queries that scan backwards from a timestamp.
CREATE INDEX IF NOT EXISTS idx_historical_prices_recorded_at
  ON historical_prices (recorded_at DESC);

COMMENT ON TABLE historical_prices IS
  'Hourly currency-pair price snapshots used for historical portfolio valuation.';
COMMENT ON COLUMN historical_prices.price IS
  'Units of quote_currency per 1 unit of base_currency at recorded_at.';
COMMENT ON COLUMN historical_prices.source IS
  'Data provider identifier: coingecko, exchangerate-api, derived, etc.';
COMMENT ON COLUMN historical_prices.recorded_at IS
  'Canonical hour bucket (minute/second truncated to 0) this price represents.';
COMMENT ON COLUMN historical_prices.fetched_at IS
  'Wall-clock time the price was fetched from the provider.';
