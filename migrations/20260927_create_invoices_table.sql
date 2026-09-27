-- Migration: 20260927_create_invoices_table
-- Description: Invoice system with sequential numbering, template support,
--              and delivery tracking. Enables monthly automated invoice
--              generation and on-demand invoice download.

-- Invoice number sequence: INV-YYYY-NNNNNN (e.g. INV-2026-000001)
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 1 INCREMENT BY 1;

-- Invoice templates: Handlebars-based customizable templates per merchant / globally
CREATE TABLE IF NOT EXISTS invoice_templates (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID,
    name            VARCHAR(100) NOT NULL,
    version         INTEGER      NOT NULL DEFAULT 1,
    html_body       TEXT         NOT NULL,
    plain_body      TEXT,
    subject         VARCHAR(255),
    branding        JSONB        NOT NULL DEFAULT '{}',
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by      VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_templates_name_version
    ON invoice_templates (merchant_id, name, version);

CREATE INDEX IF NOT EXISTS idx_invoice_templates_merchant
    ON invoice_templates (merchant_id);

CREATE INDEX IF NOT EXISTS idx_invoice_templates_active
    ON invoice_templates (merchant_id, is_active)
    WHERE is_active = TRUE;

-- Invoices: one row per invoice issued (monthly batch or ad-hoc)
CREATE TABLE IF NOT EXISTS invoices (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number    VARCHAR(30)  NOT NULL UNIQUE,
    user_id           UUID         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    merchant_id       UUID,
    template_id       UUID         REFERENCES invoice_templates (id) ON DELETE SET NULL,

    -- Billing period
    billing_month     SMALLINT     NOT NULL CHECK (billing_month BETWEEN 1 AND 12),
    billing_year      SMALLINT     NOT NULL CHECK (billing_year >= 2020),

    -- Amounts (JSON summary keyed by currency)
    currency_summary  JSONB        NOT NULL DEFAULT '{}',

    -- Status
    status            VARCHAR(30)  NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'generated', 'sent', 'failed', 'cancelled')),

    -- PDF storage
    pdf_storage_key   VARCHAR(500),      -- S3 key or local path when stored externally
    pdf_size_bytes    INTEGER,

    -- Delivery
    sent_at           TIMESTAMPTZ,
    email_message_id  VARCHAR(255),
    delivery_error    TEXT,

    -- Audit
    generated_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Prevent duplicate invoices for the same user + billing period
    CONSTRAINT uq_invoices_user_period UNIQUE (user_id, billing_month, billing_year)
);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id
    ON invoices (user_id);

CREATE INDEX IF NOT EXISTS idx_invoices_billing_period
    ON invoices (billing_year, billing_month);

CREATE INDEX IF NOT EXISTS idx_invoices_status
    ON invoices (status);

CREATE INDEX IF NOT EXISTS idx_invoices_created_at
    ON invoices (created_at DESC);

-- Helper function: generate the next invoice number in format INV-YYYY-NNNNNN
CREATE OR REPLACE FUNCTION generate_invoice_number(p_year INTEGER DEFAULT NULL)
RETURNS VARCHAR(30)
LANGUAGE plpgsql
AS $$
DECLARE
    v_seq   BIGINT;
    v_year  INTEGER;
BEGIN
    v_seq  := nextval('invoice_number_seq');
    v_year := COALESCE(p_year, EXTRACT(YEAR FROM NOW())::INTEGER);
    RETURN 'INV-' || v_year::TEXT || '-' || LPAD(v_seq::TEXT, 6, '0');
END;
$$;
