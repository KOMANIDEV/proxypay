-- Migration: add location_metadata to transactions
-- Stores anonymized geolocation data (country, city, ISP) captured at
-- transaction creation time for fraud detection and analytics.
-- Full IPs are NOT stored here — only derived location metadata (GDPR-friendly).

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS location_metadata JSONB DEFAULT NULL;

-- Index for analytics queries filtering by country
CREATE INDEX IF NOT EXISTS idx_transactions_location_country
  ON transactions ((location_metadata->>'countryCode'));

COMMENT ON COLUMN transactions.location_metadata IS
  'Anonymized geolocation metadata: {country, countryCode, city, isp, status}. No raw IPs stored.';
