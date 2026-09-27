-- Fraud alerts table for comprehensive fraud detection logging
-- Persists fraud detection results for investigation and rule improvement

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id UUID DEFAULT gen_random_uuid(),
  transaction_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255),
  score INTEGER NOT NULL DEFAULT 0,
  risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  recommended_action VARCHAR(20) NOT NULL CHECK (recommended_action IN ('allow', 'review', 'block')),
  reasons TEXT[] NOT NULL DEFAULT '{}',
  heuristics_triggered TEXT[] NOT NULL DEFAULT '{}',
  heuristic_details JSONB NOT NULL DEFAULT '{}',
  user_context JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL CHECK (status IN ('flagged', 'reviewed', 'false_positive', 'confirmed')) DEFAULT 'flagged',
  reviewed_by VARCHAR(255),
  review_notes TEXT,
  reviewed_at TIMESTAMP,
  is_false_positive BOOLEAN NOT NULL DEFAULT FALSE,
  false_positive_reason TEXT,
  duration_ms INTEGER,
  transaction_amount NUMERIC,
  transaction_type VARCHAR(20),
  provider VARCHAR(100),
  phone_number VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX idx_fraud_alerts_user_id ON fraud_alerts(user_id);
CREATE INDEX idx_fraud_alerts_transaction_id ON fraud_alerts(transaction_id);
CREATE INDEX idx_fraud_alerts_status ON fraud_alerts(status);
CREATE INDEX idx_fraud_alerts_risk_level ON fraud_alerts(risk_level);
CREATE INDEX idx_fraud_alerts_created_at ON fraud_alerts(created_at DESC);
CREATE INDEX idx_fraud_alerts_is_false_positive ON fraud_alerts(is_false_positive);

-- Review history for fraud alerts
CREATE TABLE IF NOT EXISTS fraud_alert_review_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  alert_id UUID NOT NULL REFERENCES fraud_alerts(id) ON DELETE CASCADE,
  previous_status VARCHAR(20),
  new_status VARCHAR(20) NOT NULL,
  reviewed_by VARCHAR(255) NOT NULL,
  review_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_fraud_alert_review_history_alert_id ON fraud_alert_review_history(alert_id);
