-- Migration: 20260830_create_account_merge_reviews
-- Description: Durable account merge review workflow (#570).
--              `accountMergeDryRun` collected merchant review decisions in a
--              process-local `Map`, so every decision was lost on restart, on a
--              deploy, and across the two instances behind the load balancer.
--              A merge approval is a decision to move funds; a decision that
--              evaporates is either a stuck merge or, worse, an approval that
--              gets collected again under different circumstances.
--
--              The dry-run report is stored as JSONB. It is a computed snapshot
--              taken at review time: keeping it verbatim matters, because a
--              reviewer approves the numbers they actually saw. Recomputing it
--              later from the source account would mean approving a report
--              nobody looked at.

CREATE TABLE IF NOT EXISTS account_merge_reviews (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_public_key   VARCHAR(56)  NOT NULL,

    -- Two reviews of the same account are legitimate — an operator may re-run
    -- the dry run after fixing something — so this is not unique. What is
    -- forbidden is two *pending* reviews of the same account, which is enforced
    -- by the partial unique index below rather than by a column constraint.
    dry_run_report      JSONB        NOT NULL,

    status              VARCHAR(32)  NOT NULL DEFAULT 'pending',
    review_requested_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    reviewed_at         TIMESTAMPTZ,
    reviewed_by         VARCHAR(255),
    review_notes        TEXT,

    -- Snapshot of the source account's reclaimable amount at review time, so
    -- the pending-reviews queue can be sorted by value without parsing JSONB on
    -- every read, and so an operator can see at a glance how much money is
    -- waiting on a decision.
    reclaimable_xlm     NUMERIC(30, 7),

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_account_merge_review_status
        CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),

    -- A decision is only meaningful with a decision-maker and a time. This is
    -- what makes the audit trail worth having: `approved` and `reviewed_by`
    -- cannot be set without both being real.
    CONSTRAINT chk_account_merge_review_decision
        CHECK (
            (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
         OR (status <> 'pending' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
        ),

    -- A review is about one Stellar account, so reject anything that is not
    -- shaped like one at the boundary rather than trusting the caller.
    CONSTRAINT chk_account_merge_review_source
        CHECK (char_length(source_public_key) BETWEEN 55 AND 56)
);

-- At most one pending review per account. A second submission for an account
-- that already has an open review is rejected by the database, which closes the
-- same race the asset code check in #571 has: two concurrent submissions both
-- passing a SELECT and both inserting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_merge_reviews_pending
    ON account_merge_reviews (source_public_key)
    WHERE status = 'pending';

-- The queue screen: pending reviews, newest first.
CREATE INDEX IF NOT EXISTS idx_account_merge_reviews_status_requested
    ON account_merge_reviews (status, review_requested_at DESC);

-- Looking up every review of one account, which is how an operator answers
-- "has this account been merged before, and who approved it?".
CREATE INDEX IF NOT EXISTS idx_account_merge_reviews_source
    ON account_merge_reviews (source_public_key, created_at DESC);

-- Expiry sweep: a pending review older than the cutoff. Partial, because the
-- sweep only ever looks at pending rows and the decided rows are the majority
-- of the table over time.
CREATE INDEX IF NOT EXISTS idx_account_merge_reviews_pending_age
    ON account_merge_reviews (review_requested_at)
    WHERE status = 'pending';
