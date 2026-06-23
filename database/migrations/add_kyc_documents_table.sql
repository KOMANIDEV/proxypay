-- KYC Documents table for storing uploaded document references
CREATE TABLE IF NOT EXISTS kyc_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applicant_id VARCHAR(255) NOT NULL,
  document_type VARCHAR(50) NOT NULL,
  document_side VARCHAR(10),
  file_url TEXT NOT NULL,
  s3_key TEXT NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_kyc_documents_user_id ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_documents_applicant_id ON kyc_documents(applicant_id);
CREATE INDEX IF NOT EXISTS idx_kyc_documents_created_at ON kyc_documents(created_at);

-- Auto-update updated_at on kyc_documents
CREATE OR REPLACE FUNCTION update_kyc_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kyc_documents_updated_at ON kyc_documents;
CREATE TRIGGER kyc_documents_updated_at
  BEFORE UPDATE ON kyc_documents
  FOR EACH ROW EXECUTE FUNCTION update_kyc_documents_updated_at();

-- Add comment for documentation
COMMENT ON TABLE kyc_documents IS 'Stores references to KYC documents uploaded to S3';
COMMENT ON COLUMN kyc_documents.document_type IS 'Type of document: passport, driving_license, national_identity_card, residence_permit, etc.';
COMMENT ON COLUMN kyc_documents.document_side IS 'Side of document: front, back (optional for single-sided documents)';
COMMENT ON COLUMN kyc_documents.s3_key IS 'S3 object key for retrieving the file';
