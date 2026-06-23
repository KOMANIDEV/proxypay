-- Migration: 009_add_pending_actions
-- Description: Maker-Checker approval flow for high-risk admin actions

CREATE TABLE IF NOT EXISTS pending_actions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type   VARCHAR(50) NOT NULL CHECK (action_type IN ('freeze_account', 'manual_credit', 'manual_debit', 'unlock_user')),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  payload       JSONB       NOT NULL,
  maker_id      UUID        NOT NULL REFERENCES users(id),
  checker_id    UUID        REFERENCES users(id),
  maker_note    TEXT,
  checker_note  TEXT,
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_status     ON pending_actions(status);
CREATE INDEX IF NOT EXISTS idx_pending_actions_maker_id   ON pending_actions(maker_id);
CREATE INDEX IF NOT EXISTS idx_pending_actions_checker_id ON pending_actions(checker_id);
CREATE INDEX IF NOT EXISTS idx_pending_actions_type       ON pending_actions(action_type);
