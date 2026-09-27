-- Migration: 20260825_create_preference_change_log
-- Description: Append-only audit trail for user preference changes. Every
--              settings mutation (update / reset / delete) records the
--              version transition and the fields that changed, so concurrent
--              sessions can be reconciled and support can reconstruct what
--              happened and when.
--
-- Notification webhooks for preference changes are enqueued into the shared
-- `webhook_outbox` table (event_type = 'preference.changed') so they benefit
-- from the existing at-least-once delivery worker.

CREATE TABLE IF NOT EXISTS preference_change_log (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          VARCHAR(255) NOT NULL,
    actor_id         VARCHAR(255),
    action           VARCHAR(20) NOT NULL
                     CHECK (action IN ('update', 'reset', 'delete')),
    previous_version INTEGER NOT NULL DEFAULT 0,
    new_version      INTEGER NOT NULL DEFAULT 0,
    changes          JSONB NOT NULL DEFAULT '{}',
    source           VARCHAR(50) DEFAULT 'api',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast per-user history queries for audit/UI purposes.
CREATE INDEX IF NOT EXISTS idx_preference_change_log_user
    ON preference_change_log (user_id, created_at DESC);
