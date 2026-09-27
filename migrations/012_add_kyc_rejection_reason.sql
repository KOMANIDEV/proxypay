-- Migration: 012_add_kyc_rejection_reason
-- Description: Add rejection_reason field to KYC-related tables
--
-- The kyc_applicants / kyc_tier_upgrade_requests tables are created by the
-- legacy database/migrations/ scripts, which are not part of the ordered
-- migrations/ chain. Guard the ALTERs so a fresh database (where those tables
-- do not exist) does not fail the chain.

DO $$
BEGIN
  IF to_regclass('kyc_applicants') IS NOT NULL THEN
    ALTER TABLE kyc_applicants ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('kyc_tier_upgrade_requests') IS NOT NULL THEN
    ALTER TABLE kyc_tier_upgrade_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
  END IF;
END
$$;
