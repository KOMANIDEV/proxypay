-- Daily Snapshots table for management reporting and historical growth tracking
CREATE TABLE IF NOT EXISTS daily_snapshots (
    snapshot_date DATE PRIMARY KEY,
    total_main_balance NUMERIC(20, 2) NOT NULL DEFAULT 0,
    total_vault_balance NUMERIC(20, 2) NOT NULL DEFAULT 0,
    total_balance NUMERIC(20, 2) NOT NULL DEFAULT 0,
    daily_volume NUMERIC(20, 2) NOT NULL DEFAULT 0,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for date-range queries on snapshots
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date DESC);

COMMENT ON TABLE daily_snapshots IS 'Stores end-of-day financial aggregates for management reporting.';
