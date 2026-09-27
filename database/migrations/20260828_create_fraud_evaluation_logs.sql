-- Fraud evaluation logs table for comprehensive fraud detection logging
-- Persists detailed fraud evaluation context for investigation and rule improvement

CREATE TABLE IF NOT EXISTS fraud_evaluation_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255),
  amount NUMERIC NOT NULL,
  phone_number VARCHAR(50) NOT NULL,
  provider VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'withdraw')),
  status VARCHAR(20),
  ip_address INET,
  user_agent TEXT,
  device_fingerprint VARCHAR(255),
  is_fraud BOOLEAN NOT NULL DEFAULT FALSE,
  score INTEGER NOT NULL DEFAULT 0,
  risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  recommended_action VARCHAR(20) NOT NULL CHECK (recommended_action IN ('allow', 'review', 'block')),
  reasons TEXT[] NOT NULL DEFAULT '{}',
  heuristics_triggered TEXT[] NOT NULL DEFAULT '{}',
  heuristic_details JSONB NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  transaction_history_count INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_fraud_evaluation_logs_user_id ON fraud_evaluation_logs(user_id);
CREATE INDEX idx_fraud_evaluation_logs_transaction_id ON fraud_evaluation_logs(transaction_id);
CREATE INDEX idx_fraud_evaluation_logs_is_fraud ON fraud_evaluation_logs(is_fraud);
CREATE INDEX idx_fraud_evaluation_logs_risk_level ON fraud_evaluation_logs(risk_level);
CREATE INDEX idx_fraud_evaluation_logs_created_at ON fraud_evaluation_logs(created_at DESC);
CREATE INDEX idx_fraud_evaluation_logs_provider ON fraud_evaluation_logs(provider);
