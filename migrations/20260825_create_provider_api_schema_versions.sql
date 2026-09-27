-- Migration: 20260825_create_provider_api_schema_versions
-- Description: Track versioned snapshots of provider API request/response
--              contracts so silent contract changes can be detected,
--              alerted on and rolled back.
--
-- Each row is a captured snapshot of the schema for a (provider, endpoint)
-- pair. The schema_hash is the SHA-256 of the canonicalised schema JSON, so
-- identical contracts never create duplicate versions. version follows
-- semver: MAJOR bumps on breaking changes, MINOR bumps on additive changes.

CREATE TABLE IF NOT EXISTS provider_api_schema_versions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider              VARCHAR(50) NOT NULL,
    endpoint              VARCHAR(255) NOT NULL,
    version               VARCHAR(20) NOT NULL,
    schema_hash           CHAR(64) NOT NULL,
    schema                JSONB NOT NULL,
    breaking_change_paths TEXT[] NOT NULL DEFAULT '{}',
    change_counts         JSONB NOT NULL DEFAULT '{}',
    detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    alerted_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, endpoint, version)
);

-- Fast lookup of the most recent capture per (provider, endpoint).
CREATE INDEX IF NOT EXISTS idx_provider_schema_latest
    ON provider_api_schema_versions (provider, endpoint, detected_at DESC);
