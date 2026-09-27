-- Migration: 20260925_create_compliance_audit_log
-- Description: Compliance audit trail for privileged administrative actions
--              that override regulated state (for example an admin overriding
--              a user's KYC tier). Records the actor, the override reason and
--              the before/after values so compliance history is complete.

CREATE TABLE IF NOT EXISTS compliance_audit_log (
    id             VARCHAR(64)  PRIMARY KEY,
    actor_id       VARCHAR(255) NOT NULL,
    actor_role     VARCHAR(100),
    action         VARCHAR(100) NOT NULL,
    resource_type  VARCHAR(100) NOT NULL,
    resource_id    VARCHAR(255) NOT NULL,
    reason         TEXT,
    previous_value JSONB,
    new_value      JSONB,
    metadata       JSONB        NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_audit_log_resource
    ON compliance_audit_log (resource_type, resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_audit_log_actor
    ON compliance_audit_log (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_audit_log_action
    ON compliance_audit_log (action, created_at DESC);
