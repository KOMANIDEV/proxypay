-- Migration: Create ledger integrity validation reports table
-- Created at: 2026-07-30

CREATE TABLE ledger_integrity_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    is_balanced BOOLEAN NOT NULL,
    total_debits NUMERIC(20,7) NOT NULL,
    total_credits NUMERIC(20,7) NOT NULL,
    difference NUMERIC(20,7) NOT NULL,
    unbalanced_transaction_count INTEGER NOT NULL DEFAULT 0,
    integrity_score NUMERIC(5,2) NOT NULL,
    discrepancies JSONB DEFAULT '[]',
    checked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ledger_integrity_reports_checked_at ON ledger_integrity_reports(checked_at DESC);
