-- Migration: create idempotency_keys
-- Stores the response of a mutating request against its Idempotency-Key so a
-- retried request replays the original result instead of being processed twice.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           VARCHAR(255) PRIMARY KEY,
  method        VARCHAR(10)  NOT NULL,
  path          VARCHAR(512) NOT NULL,
  request_hash  VARCHAR(64)  NOT NULL,
  state         VARCHAR(16)  NOT NULL DEFAULT 'in_progress'
                CHECK (state IN ('in_progress', 'completed')),
  status_code   INTEGER,
  response_body JSONB,
  expires_at    TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at);
