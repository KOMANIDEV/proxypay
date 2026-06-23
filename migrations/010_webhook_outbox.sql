-- Migration: 010_webhook_outbox
-- Description: Create outbox table to guarantee at-least-once webhook delivery

CREATE TABLE webhook_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending' 
                    CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
    attempts        INTEGER DEFAULT 0,
    max_attempts    INTEGER DEFAULT 5,
    last_attempt_at TIMESTAMP,
    next_attempt_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_message   TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webhook_outbox_status_next_retry ON webhook_outbox (status, next_attempt_at) WHERE status IN ('pending', 'failed');