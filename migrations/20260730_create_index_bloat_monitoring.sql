-- Migration: Enable index bloat monitoring
-- Created at: 2026-07-30

CREATE EXTENSION IF NOT EXISTS pgstattuple;

CREATE TABLE index_bloat_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schemaname VARCHAR(255) NOT NULL,
    tablename VARCHAR(255) NOT NULL,
    indexname VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL,
    bloat_pct NUMERIC(5,2) NOT NULL,
    checked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_index_bloat_history_index ON index_bloat_history(schemaname, tablename, indexname, checked_at DESC);
CREATE INDEX idx_index_bloat_history_checked_at ON index_bloat_history(checked_at DESC);
