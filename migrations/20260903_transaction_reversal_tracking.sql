-- Migration: 20260903_transaction_reversal_tracking
-- Description: Persistent reversal state tracking and audit trail (#483).
--
-- The existing reversal path only flipped `transactions.status` and posted a
-- compensating ledger entry, leaving no record of *who* reversed a payment,
-- *why*, or whether a reversal had already been attempted and failed. These
-- tables close that gap:
--
--   * transaction_reversals        – one row per reversal attempt, tracking
--                                    the state machine
--                                    (requested -> posted -> notified, or
--                                    failed) and the full actor/reason trail.
--   * transaction_reversal_events  – immutable append-only audit log of every
--                                    state change on a reversal.

CREATE TABLE IF NOT EXISTS transaction_reversals (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id     UUID NOT NULL,
    original_reference VARCHAR(100) NOT NULL,
    reversal_reference VARCHAR(100),
    reason             TEXT NOT NULL,
    status             VARCHAR(20) NOT NULL DEFAULT 'requested',
    requested_by       VARCHAR(255),
    approved_by        VARCHAR(255),
    ledger_entries     INTEGER NOT NULL DEFAULT 0,
    already_reversed   BOOLEAN NOT NULL DEFAULT FALSE,
    error              TEXT,
    notified_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT transaction_reversals_status_check
      CHECK (status IN ('requested', 'posted', 'notified', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_transaction_reversals_transaction
    ON transaction_reversals (transaction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_reversals_status
    ON transaction_reversals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_reversals_reference
    ON transaction_reversals (reversal_reference);

CREATE TABLE IF NOT EXISTS transaction_reversal_events (
    id            BIGSERIAL PRIMARY KEY,
    reversal_id   UUID NOT NULL REFERENCES transaction_reversals (id) ON DELETE CASCADE,
    from_status   VARCHAR(20),
    to_status     VARCHAR(20) NOT NULL,
    actor_id      VARCHAR(255),
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transaction_reversal_events_reversal
    ON transaction_reversal_events (reversal_id, created_at DESC);
