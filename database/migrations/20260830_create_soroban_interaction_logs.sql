CREATE TABLE IF NOT EXISTS soroban_interaction_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(56) NOT NULL,
    method VARCHAR(128) NOT NULL,
    source_account VARCHAR(56),
    state_change BOOLEAN NOT NULL DEFAULT false,
    arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
    transaction_xdr TEXT,
    transaction_hash VARCHAR(64),
    status VARCHAR(16) NOT NULL,
    simulation_gas_used BIGINT,
    execution_gas_used BIGINT,
    resource_fee NUMERIC,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_soroban_interaction_logs_contract
    ON soroban_interaction_logs (contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soroban_interaction_logs_hash
    ON soroban_interaction_logs (transaction_hash);