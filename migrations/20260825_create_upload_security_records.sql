-- Migration: 20260825_create_upload_security_records
-- Description: Track antivirus scanning, quarantine lifecycle and integrity
--              checks for every file uploaded to the platform.
--
-- Scan lifecycle:
--   pending    – record created, scan not finished
--   clean      – scanned and no threats found
--   infected   – scanner found one or more threats; upload must be rejected
--   quarantined– scan inconclusive / scanner unavailable; held for the
--                quarantine period before it may be approved
--   approved   – quarantine period elapsed (auto) or manually approved
--   rejected   – manually rejected after review
--
-- The sha256 column doubles as the file-integrity anchor: consumers can
-- re-hash a stored object and compare it against this value to detect
-- tampering after upload.

CREATE TABLE IF NOT EXISTS upload_security_records (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           VARCHAR(255),
    original_filename VARCHAR(1024) NOT NULL,
    stored_key        VARCHAR(2048),
    declared_mimetype VARCHAR(255) NOT NULL,
    detected_mimetype VARCHAR(255),
    sha256            CHAR(64) NOT NULL,
    size_bytes        BIGINT NOT NULL,
    scan_status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (scan_status IN
                        ('pending', 'clean', 'infected', 'quarantined', 'approved', 'rejected')),
    scan_engine       VARCHAR(100),
    threats           TEXT[] NOT NULL DEFAULT '{}',
    quarantine_until  TIMESTAMPTZ,
    scanned_at        TIMESTAMPTZ,
    approved_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup by content hash (dedupe / integrity verification).
CREATE INDEX IF NOT EXISTS idx_upload_security_sha256
    ON upload_security_records (sha256);

-- Efficient sweep of quarantined records whose hold period has elapsed.
CREATE INDEX IF NOT EXISTS idx_upload_security_quarantine
    ON upload_security_records (scan_status, quarantine_until)
    WHERE scan_status = 'quarantined';
