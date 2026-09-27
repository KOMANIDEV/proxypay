-- Rollback: 20260424_create_daily_snapshots
-- Inverted from 20260424_create_daily_snapshots.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS daily_snapshots;
DROP INDEX IF EXISTS idx_daily_snapshots_date;
