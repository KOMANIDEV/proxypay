-- Rollback: 012_add_kyc_rejection_reason
-- The kyc_applicants / kyc_tier_upgrade_requests tables are created by legacy
-- database/migrations/ scripts that are not part of the ordered chain; guard
-- the drops so fresh databases (where the tables do not exist) do not fail.

DO $$
BEGIN
  IF to_regclass('kyc_applicants') IS NOT NULL THEN
    ALTER TABLE kyc_applicants DROP COLUMN IF EXISTS rejection_reason;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('kyc_tier_upgrade_requests') IS NOT NULL THEN
    ALTER TABLE kyc_tier_upgrade_requests DROP COLUMN IF EXISTS rejection_reason;
  END IF;
END
$$;
