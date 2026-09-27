-- Migration: 20260829_create_receipt_templates
-- Description: Template management system for transaction receipts.
--              Lets businesses customize receipt branding/content with
--              versioned Handlebars templates plus business branding
--              (logo, business name, colors).

CREATE TABLE IF NOT EXISTS receipt_templates (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id  UUID,
    name         VARCHAR(100) NOT NULL,
    version      INTEGER      NOT NULL DEFAULT 1,
    html_body    TEXT         NOT NULL,
    plain_body   TEXT,
    branding     JSONB        NOT NULL DEFAULT '{}',
    is_active    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_by   VARCHAR(255),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_templates_name_version
    ON receipt_templates (merchant_id, name, version);

CREATE INDEX IF NOT EXISTS idx_receipt_templates_merchant
    ON receipt_templates (merchant_id);

CREATE INDEX IF NOT EXISTS idx_receipt_templates_active
    ON receipt_templates (merchant_id, is_active)
    WHERE is_active = TRUE;
