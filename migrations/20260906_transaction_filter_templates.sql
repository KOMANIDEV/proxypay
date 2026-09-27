-- Migration: 20260906_transaction_filter_templates
-- Description: Saved filter templates for advanced transaction filtering
--              (#480). Operators and merchants reuse the same complex
--              filter expressions, so the expression is persisted rather
--              than retyped.
--
--   * transaction_filter_templates – named, shareable filter expressions with
--                                    an export/import payload so a template
--                                    can move between environments.
--   * transaction_filter_usage    – per-template usage counters, which let
--                                    the least useful templates be retired.

CREATE TABLE IF NOT EXISTS transaction_filter_templates (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(100) NOT NULL,
    description  TEXT,
    -- The filter expression tree (see src/services/transactionFilterService.ts)
    expression   JSONB NOT NULL,
    -- Serialised form used for export/import: the expression plus the
    -- template metadata, so an export is self-describing.
    export_payload JSONB NOT NULL DEFAULT '{}',
    is_shared    BOOLEAN NOT NULL DEFAULT FALSE,
    is_system    BOOLEAN NOT NULL DEFAULT FALSE,
    owner_id     VARCHAR(255),
    usage_count  BIGINT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_filter_templates_owner_name
    ON transaction_filter_templates (COALESCE(owner_id, 'system'), name);

CREATE INDEX IF NOT EXISTS idx_transaction_filter_templates_shared
    ON transaction_filter_templates (is_shared, updated_at DESC);

CREATE TABLE IF NOT EXISTS transaction_filter_usage (
    id          BIGSERIAL PRIMARY KEY,
    template_id UUID NOT NULL REFERENCES transaction_filter_templates (id) ON DELETE CASCADE,
    used_by     VARCHAR(255),
    result_count INTEGER,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transaction_filter_usage_template
    ON transaction_filter_usage (template_id, executed_at DESC);
