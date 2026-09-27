-- Webhook retry policy configuration per merchant
-- Allows configuring backoff parameters independently for each merchant

CREATE TABLE IF NOT EXISTS webhook_retry_policies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_id VARCHAR(255) NOT NULL UNIQUE,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1 AND max_attempts <= 10),
  base_delay_ms INTEGER NOT NULL DEFAULT 500 CHECK (base_delay_ms >= 100),
  max_delay_ms INTEGER NOT NULL DEFAULT 30000 CHECK (max_delay_ms >= 1000),
  multiplier NUMERIC(3,1) NOT NULL DEFAULT 2.0 CHECK (multiplier >= 1.0 AND multiplier <= 10.0),
  jitter_factor NUMERIC(3,2) NOT NULL DEFAULT 0.20 CHECK (jitter_factor >= 0 AND jitter_factor <= 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webhook_retry_policies_merchant_id ON webhook_retry_policies(merchant_id);
