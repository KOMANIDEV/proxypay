-- Rollback: 20260830_create_asset_issuance_requests
--
-- Drops the table outright rather than trying to preserve rows. There is no
-- safer option worth offering: without this table the feature is inoperable, so
-- a deployment that is rolling this back has already decided it does not want
-- asset issuance, and the pending requests it would be preserving describe
-- assets that were never issued (a request only becomes 'completed' after the
-- on-chain issue succeeds).
--
-- Reviewers who want the data kept should copy the table out before rolling
-- back rather than expecting the migration to hedge.

DROP TABLE IF EXISTS asset_issuance_requests;
