CREATE TABLE IF NOT EXISTS liquidity_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_provider VARCHAR(20) NOT NULL,
  to_provider VARCHAR(20) NOT NULL,
  amount DECIMAL(20, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'XAF',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  triggered_by VARCHAR(20) NOT NULL DEFAULT 'auto'
    CHECK (triggered_by IN ('auto', 'admin')),
  admin_id UUID REFERENCES users(id),
  note TEXT,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_liquidity_transfers_status ON liquidity_transfers(status);
CREATE INDEX idx_liquidity_transfers_created_at ON liquidity_transfers(created_at);
CREATE INDEX idx_liquidity_transfers_providers ON liquidity_transfers(from_provider, to_provider);
