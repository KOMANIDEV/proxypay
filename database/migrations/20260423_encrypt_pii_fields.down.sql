-- Rollback: remove encrypted PII columns from kyc_applicants
ALTER TABLE kyc_applicants
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS id_number;
