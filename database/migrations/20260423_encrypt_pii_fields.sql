-- Migration: Encrypt PII fields (name, address, id_number) on kyc_applicants
-- These columns store AES-256-GCM ciphertext serialised as TEXT:
--   <iv_hex>:<authTag_hex>:<ciphertext_hex>
--
-- Rollback: 20260423_encrypt_pii_fields.down.sql

-- Add encrypted PII columns to kyc_applicants
-- Using TEXT so the serialised iv:authTag:ciphertext string fits without truncation.
ALTER TABLE kyc_applicants
  ADD COLUMN IF NOT EXISTS name       TEXT,
  ADD COLUMN IF NOT EXISTS address    TEXT,
  ADD COLUMN IF NOT EXISTS id_number  TEXT;

-- Comments make the intent clear to future engineers and auditors
COMMENT ON COLUMN kyc_applicants.name      IS 'AES-256-GCM encrypted full name (iv:authTag:ciphertext hex)';
COMMENT ON COLUMN kyc_applicants.address   IS 'AES-256-GCM encrypted residential address (iv:authTag:ciphertext hex)';
COMMENT ON COLUMN kyc_applicants.id_number IS 'AES-256-GCM encrypted government ID number (iv:authTag:ciphertext hex)';
