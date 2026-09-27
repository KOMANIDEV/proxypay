-- Migration: Encrypt existing unencrypted transaction data
-- This is a one-time data migration to ensure all sensitive transaction fields are encrypted.
--
-- IMPORTANT: This migration assumes the DB_ENCRYPTION_KEY environment variable is set.
-- Run this migration only after deploying the encryption code.
--
-- WARNING: This migration is NOT reversible without the encryption key.
-- Create a backup before running this migration.
--
-- Rollback: Not recommended. If you must rollback, restore from backup.

-- Create a function to check if data appears to be encrypted
-- Encrypted data typically has the format: <hex>:<hex>:<hex> (3 parts separated by colons)
CREATE OR REPLACE FUNCTION is_encrypted(data TEXT) RETURNS BOOLEAN AS $$
BEGIN
  -- Check if data matches encrypted format (iv:authTag:ciphertext)
  -- Each part should be hex characters only
  RETURN data ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$';
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create a function to check if data appears to be versioned encrypted
-- Versioned format: <version>:<iv>:<authTag>:<ciphertext>
CREATE OR REPLACE FUNCTION is_versioned_encrypted(data TEXT) RETURNS BOOLEAN AS $$
BEGIN
  -- Check if data matches versioned encrypted format
  -- First part is version (alphanumeric), rest is encrypted payload
  RETURN data ~ '^[a-z0-9_]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$';
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Log statistics about unencrypted data (for verification before migration)
-- Run this query first to understand what needs to be encrypted:
/*
SELECT 
  'transactions' as table_name,
  'phone_number' as column_name,
  COUNT(*) as total_rows,
  COUNT(CASE WHEN NOT is_encrypted(phone_number::text) AND NOT is_versioned_encrypted(phone_number::text) THEN 1 END) as unencrypted_count
FROM transactions
UNION ALL
SELECT 
  'transactions',
  'stellar_address',
  COUNT(*),
  COUNT(CASE WHEN NOT is_encrypted(stellar_address::text) AND NOT is_versioned_encrypted(stellar_address::text) THEN 1 END)
FROM transactions
UNION ALL
SELECT 
  'transactions',
  'notes',
  COUNT(*),
  COUNT(CASE WHEN notes IS NOT NULL AND NOT is_encrypted(notes) AND NOT is_versioned_encrypted(notes) THEN 1 END)
FROM transactions
UNION ALL
SELECT 
  'users',
  'phone_number',
  COUNT(*),
  COUNT(CASE WHEN NOT is_encrypted(phone_number::text) AND NOT is_versioned_encrypted(phone_number::text) THEN 1 END)
FROM users;
*/

-- Note: The actual encryption of existing data should be done via a TypeScript script
-- that uses the application's encryption utilities. This is because:
-- 1. The encryption key is managed via environment variables, not SQL
-- 2. The encryption logic includes key derivation and versioning
-- 3. PostgreSQL's pgcrypto extension would require different key management
--
-- Example TypeScript migration script:
/*
import { encrypt } from '../src/utils/encryption';
import { queryRead, queryWrite } from '../src/config/database';

async function encryptExistingData() {
  // Encrypt unencrypted transaction phone numbers
  const unencryptedPhones = await queryRead(`
    SELECT id, phone_number FROM transactions 
    WHERE NOT is_encrypted(phone_number::text) 
    AND NOT is_versioned_encrypted(phone_number::text)
  `);
  
  for (const row of unencryptedPhones.rows) {
    const encrypted = encrypt(row.phone_number);
    await queryWrite(
      'UPDATE transactions SET phone_number = $1 WHERE id = $2',
      [encrypted, row.id]
    );
  }
  
  // Similar for stellar_address, notes, etc.
}

encryptExistingData().catch(console.error);
*/

-- Clean up helper functions (optional, can be kept for future use)
-- DROP FUNCTION IF EXISTS is_encrypted(TEXT);
-- DROP FUNCTION IF EXISTS is_versioned_encrypted(TEXT);
