-- Migration: 20260830_create_asset_issuance_requests
-- Description: Asset issuance request workflow (#571).
--              `assetWorkflowService` has read and written this table since it
--              landed, but no migration ever created it: the whole asset
--              issuance feature was dead on arrival in a fresh environment and
--              only ever worked against a database someone had fixed by hand.
--              This migration creates the table the code already expects.
--
--              The part #571 actually depends on is the unique constraint on
--              asset_code. Duplicate detection in the service was a
--              SELECT-then-INSERT, which two concurrent requests both pass and
--              both insert. The database is the only place where "these two
--              requests collided" is knowable at the moment of collision, so
--              the constraint is the real check and the SELECT is only a
--              friendlier fast path. Note that an asset code is unique across
--              ALL requests, not per merchant: on Stellar the asset is
--              identified by (code, issuer), but the platform issues every
--              asset from a single issuer key, so a code claimed once must stay
--              claimed whatever the requester.

CREATE TABLE IF NOT EXISTS asset_issuance_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_code        VARCHAR(12)  NOT NULL,
    name              VARCHAR(255) NOT NULL,
    description       TEXT,
    limit             VARCHAR(64)  NOT NULL,
    status            VARCHAR(32)  NOT NULL DEFAULT 'draft',
    requested_by      VARCHAR(255) NOT NULL,
    approved_by       VARCHAR(255),
    approval_notes    TEXT,
    trustline_config  JSONB,
    metadata          JSONB        NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- The asset code is capped at 12 characters because that is Stellar's own
    -- limit, enforced here as well so a bad code is rejected by the database
    -- and not merely by a validation function that some other code path might
    -- forget to call.
    CONSTRAINT chk_asset_issuance_code_length
        CHECK (char_length(asset_code) BETWEEN 3 AND 12),

    -- Alphanumeric only. Without this the code could contain a colon, which is
    -- the separator in the "CODE:ISSUER" asset identifier format the rest of
    -- the codebase parses, so a colon in an asset code would let one asset be
    -- read back as a different one.
    CONSTRAINT chk_asset_issuance_code_alphanumeric
        CHECK (asset_code ~ '^[A-Za-z0-9]+$'),

    CONSTRAINT chk_asset_issuance_status
        CHECK (status IN (
            'draft', 'pending_approval', 'approved', 'rejected',
            'issuing', 'completed', 'failed'
        )),

    -- A limit is stored as text because it is a Stellar amount, which is an
    -- arbitrary-precision decimal. Checking it here catches the obvious
    -- mistakes ('abc', '-1') without pretending to validate the precision.
    CONSTRAINT chk_asset_issuance_limit_positive
        CHECK (limit ~ '^[0-9]+(\.[0-9]+)?$')
);

-- The duplicate-asset guard. Two requests for 'USDC' submitted at the same
-- instant cannot both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_issuance_requests_code
    ON asset_issuance_requests (asset_code);

-- The approval queue reads by status, so that lookup should not be a scan.
CREATE INDEX IF NOT EXISTS idx_asset_issuance_requests_status
    ON asset_issuance_requests (status)
    WHERE status IN ('pending_approval', 'approved');

-- Requests are listed per requester, and 'requested_by' is a varchar user id
-- rather than a uuid, matching how the service stores it.
CREATE INDEX IF NOT EXISTS idx_asset_issuance_requests_requester
    ON asset_issuance_requests (requested_by, created_at DESC);
