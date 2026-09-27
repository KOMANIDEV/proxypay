-- Migration: 20260902_provider_api_version_management
-- Description: Explicit provider API version tracking (#484).
--
-- Complements provider_api_schema_versions (which snapshots the *shape* of a
-- contract) by tracking the *version* a provider integration is pinned to:
--
--   * provider_api_versions          – every version ever registered, the
--                                      request-formatting profile applied to
--                                      it and its lifecycle status.
--   * provider_api_version_compat    – declared compatibility between a
--                                      provider version and a bridge client
--                                      version.
--   * provider_api_version_events    – immutable log of version lifecycle
--                                      notifications (registered, promoted,
--                                      deprecated, retired).

CREATE TABLE IF NOT EXISTS provider_api_versions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider              VARCHAR(50) NOT NULL,
    version               VARCHAR(20) NOT NULL,
    status                VARCHAR(20) NOT NULL DEFAULT 'active',
    request_format        JSONB NOT NULL DEFAULT '{}'::jsonb,
    changelog             TEXT,
    effective_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deprecated_at          TIMESTAMPTZ,
    sunset_at              TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, version),
    CONSTRAINT provider_api_versions_status_check
      CHECK (status IN ('active', 'deprecated', 'retired'))
);

CREATE INDEX IF NOT EXISTS idx_provider_api_versions_lookup
    ON provider_api_versions (provider, status, effective_from DESC);

CREATE TABLE IF NOT EXISTS provider_api_version_compat (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider          VARCHAR(50) NOT NULL,
    provider_version  VARCHAR(20) NOT NULL,
    bridge_version    VARCHAR(20) NOT NULL,
    compatible        BOOLEAN NOT NULL DEFAULT TRUE,
    constraints       JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_version, bridge_version),
    FOREIGN KEY (provider, provider_version)
      REFERENCES provider_api_versions (provider, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_api_version_events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider          VARCHAR(50) NOT NULL,
    version           VARCHAR(20) NOT NULL,
    event_type        VARCHAR(30) NOT NULL,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
    notified_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT provider_api_version_events_type_check
      CHECK (event_type IN ('registered', 'activated', 'deprecated',
                            'retired', 'incompatible'))
);

CREATE INDEX IF NOT EXISTS idx_provider_api_version_events_recent
    ON provider_api_version_events (provider, created_at DESC);
