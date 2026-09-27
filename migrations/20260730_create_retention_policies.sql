-- Migration: create retention_policies and retention_purge_audit
-- Holds a configurable GDPR retention period per data type, plus an audit
-- trail of every purge run so compliance can evidence enforcement.

CREATE TABLE IF NOT EXISTS retention_policies (
  data_type      VARCHAR(64) PRIMARY KEY,
  retention_days INTEGER     NOT NULL CHECK (retention_days > 0),
  enabled        BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS retention_purge_audit (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  data_type        VARCHAR(64) NOT NULL,
  retention_days   INTEGER     NOT NULL,
  cutoff_at        TIMESTAMP WITH TIME ZONE NOT NULL,
  records_affected INTEGER     NOT NULL DEFAULT 0,
  outcome          VARCHAR(16) NOT NULL CHECK (outcome IN ('success', 'failed', 'skipped')),
  error            TEXT,
  executed_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_retention_purge_audit_executed_at
  ON retention_purge_audit (executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_retention_purge_audit_data_type
  ON retention_purge_audit (data_type, executed_at DESC);

-- Seed defaults: 7 years for financial/PII records, 1 year for logs.
INSERT INTO retention_policies (data_type, retention_days) VALUES
  ('transactions', 2555),
  ('logs', 365),
  ('pii', 2555)
ON CONFLICT (data_type) DO NOTHING;
