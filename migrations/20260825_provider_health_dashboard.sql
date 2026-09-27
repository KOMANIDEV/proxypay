-- #405 – Provider Health Dashboard
-- Adds a time-series table for hourly provider health snapshots
-- used to power historical trend graphs in the dashboard.

CREATE TABLE IF NOT EXISTS provider_health_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  provider        VARCHAR(20) NOT NULL CHECK (provider IN ('mtn', 'airtel', 'orange')),
  snapshot_hour   TIMESTAMPTZ NOT NULL,  -- truncated to the hour
  total_calls     INT NOT NULL DEFAULT 0,
  success_calls   INT NOT NULL DEFAULT 0,
  failed_calls    INT NOT NULL DEFAULT 0,
  avg_duration_ms NUMERIC(10,2),
  p95_duration_ms NUMERIC(10,2),
  availability_pct NUMERIC(5,2) GENERATED ALWAYS AS (
    CASE WHEN total_calls = 0 THEN NULL
         ELSE ROUND((success_calls::numeric / total_calls) * 100, 2)
    END
  ) STORED,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_provider_snapshot_hour UNIQUE (provider, snapshot_hour)
);

CREATE INDEX IF NOT EXISTS idx_provider_health_snapshots_provider_hour
  ON provider_health_snapshots (provider, snapshot_hour DESC);

CREATE INDEX IF NOT EXISTS idx_provider_health_snapshots_hour
  ON provider_health_snapshots (snapshot_hour DESC);

-- ─── Materialized view: last-hour summary ──────────────────────────────────────
-- Used by the real-time status endpoint for sub-second response.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_provider_current_health AS
SELECT
  provider,
  COUNT(*)                                       AS total_calls,
  COUNT(*) FILTER (WHERE success)                AS success_calls,
  ROUND(AVG(duration_ms)::numeric, 2)            AS avg_duration_ms,
  ROUND(
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2
  )                                              AS p95_duration_ms,
  ROUND(
    (COUNT(*) FILTER (WHERE success))::numeric / NULLIF(COUNT(*), 0) * 100, 2
  )                                              AS availability_pct,
  MAX(called_at)                                 AS last_called_at
FROM provider_api_calls
WHERE called_at >= NOW() - INTERVAL '1 hour'
GROUP BY provider;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_provider_current_health_provider
  ON mv_provider_current_health (provider);

-- Comment: refresh this view every minute via a scheduled job or
-- after each provider_api_calls INSERT trigger.
