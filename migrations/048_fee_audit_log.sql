CREATE TABLE IF NOT EXISTS fee_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  user_id UUID,
  provider VARCHAR(50),
  input_amount NUMERIC(20,8) NOT NULL,
  calculated_fee NUMERIC(20,8) NOT NULL,
  total_amount NUMERIC(20,8) NOT NULL,
  strategy_id UUID NOT NULL,
  strategy_name VARCHAR(255) NOT NULL,
  strategy_type VARCHAR(50) NOT NULL,
  strategy_scope VARCHAR(50) NOT NULL,
  fee_percentage NUMERIC(10,4),
  flat_amount NUMERIC(20,8),
  fee_minimum NUMERIC(20,8),
  fee_maximum NUMERIC(20,8),
  time_override_active BOOLEAN NOT NULL DEFAULT false,
  raw_fee NUMERIC(20,8) NOT NULL,
  clamped_fee NUMERIC(20,8) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fee_audit_log_transaction_id ON fee_audit_log(transaction_id);
CREATE INDEX IF NOT EXISTS idx_fee_audit_log_user_id ON fee_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_fee_audit_log_created_at ON fee_audit_log(created_at);
