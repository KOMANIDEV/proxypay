-- Migration: 20260905_notification_delivery_tracking
-- Description: Per-channel delivery tracking for the notification system
--              (#479). The router currently swallows channel errors, so
--              there is no way to tell whether notifications are actually
--              being delivered.
--
--   * notification_deliveries      – one row per (notification, channel)
--                                    attempt with its outcome and latency.
--   * notification_channel_health  – rolling per-channel health snapshot
--                                    powering the status endpoint and the
--                                    failure alerting job.

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_key VARCHAR(255) NOT NULL,
    channel          VARCHAR(20)  NOT NULL,
    category         VARCHAR(100),
    severity         VARCHAR(20),
    user_id          UUID,
    transaction_id   UUID,
    status           VARCHAR(20)  NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
    duration_ms      INTEGER      NOT NULL DEFAULT 0,
    error_message    TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    delivered_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_key
    ON notification_deliveries (notification_key);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel_created
    ON notification_deliveries (channel, created_at DESC);

-- Partial index for the failure-alerting job: only failed rows are scanned.
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_failed
    ON notification_deliveries (created_at DESC)
    WHERE status = 'failed';

CREATE TABLE IF NOT EXISTS notification_channel_health (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         VARCHAR(20) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'healthy'
                    CHECK (status IN ('healthy', 'degraded', 'down')),
    success_count   BIGINT NOT NULL DEFAULT 0,
    failure_count   BIGINT NOT NULL DEFAULT 0,
    avg_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_error      TEXT,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (channel)
);

CREATE INDEX IF NOT EXISTS idx_notification_channel_health_status
    ON notification_channel_health (status);
