/**
 * Data migration script to encrypt existing unencrypted transaction data.
 * 
 * This script should be run once after deploying the encryption code.
 * It encrypts any plaintext data in sensitive transaction fields.
 * 
 * Usage:
 *   npx tsx src/scripts/encrypt-existing-data.ts
 * 
 * Prerequisites:
 *   - DB_ENCRYPTION_KEY environment variable must be set
 *   - Database must be accessible
 *   - Create a backup before running this migration
 * 
 * WARNING: This migration is NOT reversible without the encryption key.
 */

import { queryRead, queryWrite } from "../config/database";
import { encrypt, isEncrypted } from "../utils/encryption";
import logger from "../utils/logger";

interface MigrationStats {
  tableName: string;
  columnName: string;
  totalRows: number;
  encryptedRows: number;
  unencryptedRows: number;
  errors: number;
}

/**
 * Check if a value appears to be already encrypted.
 * Encrypted data has format: <hex>:<hex>:<hex> or <version>:<hex>:<hex>:<hex>
 */
function isAlreadyEncrypted(value: string | null | undefined): boolean {
  if (!value) return true; // null/undefined values don't need encryption
  return isEncrypted(value);
}

/**
 * Encrypt unencrypted transaction phone numbers
 */
async function encryptTransactionPhoneNumbers(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    tableName: 'transactions',
    columnName: 'phone_number',
    totalRows: 0,
    encryptedRows: 0,
    unencryptedRows: 0,
    errors: 0,
  };

  try {
    // Get all transactions
    const result = await queryRead(`
      SELECT id, phone_number FROM transactions 
      WHERE phone_number IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10000
    `);

    stats.totalRows = result.rows.length;
    logger.info(`Found ${stats.totalRows} transactions with phone numbers`);

    for (const row of result.rows) {
      try {
        if (isAlreadyEncrypted(row.phone_number)) {
          stats.encryptedRows++;
          continue;
        }

        // Encrypt the phone number
        const encrypted = encrypt(row.phone_number);
        await queryWrite(
          'UPDATE transactions SET phone_number = $1, updated_at = NOW() WHERE id = $2',
          [encrypted, row.id]
        );

        stats.unencryptedRows++;
        logger.debug(`Encrypted phone number for transaction ${row.id}`);
      } catch (error) {
        stats.errors++;
        logger.error(error, `Failed to encrypt phone number for transaction ${row.id}`);
      }
    }

    logger.info(`Phone number migration complete: ${stats.unencryptedRows} encrypted, ${stats.encryptedRows} already encrypted, ${stats.errors} errors`);
  } catch (error) {
    logger.error(error, 'Failed to migrate transaction phone numbers');
    throw error;
  }

  return stats;
}

/**
 * Encrypt unencrypted transaction stellar addresses
 */
async function encryptTransactionStellarAddresses(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    tableName: 'transactions',
    columnName: 'stellar_address',
    totalRows: 0,
    encryptedRows: 0,
    unencryptedRows: 0,
    errors: 0,
  };

  try {
    const result = await queryRead(`
      SELECT id, stellar_address FROM transactions 
      WHERE stellar_address IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10000
    `);

    stats.totalRows = result.rows.length;
    logger.info(`Found ${stats.totalRows} transactions with stellar addresses`);

    for (const row of result.rows) {
      try {
        if (isAlreadyEncrypted(row.stellar_address)) {
          stats.encryptedRows++;
          continue;
        }

        const encrypted = encrypt(row.stellar_address);
        await queryWrite(
          'UPDATE transactions SET stellar_address = $1, updated_at = NOW() WHERE id = $2',
          [encrypted, row.id]
        );

        stats.unencryptedRows++;
        logger.debug(`Encrypted stellar address for transaction ${row.id}`);
      } catch (error) {
        stats.errors++;
        logger.error(error, `Failed to encrypt stellar address for transaction ${row.id}`);
      }
    }

    logger.info(`Stellar address migration complete: ${stats.unencryptedRows} encrypted, ${stats.encryptedRows} already encrypted, ${stats.errors} errors`);
  } catch (error) {
    logger.error(error, 'Failed to migrate transaction stellar addresses');
    throw error;
  }

  return stats;
}

/**
 * Encrypt unencrypted transaction notes
 */
async function encryptTransactionNotes(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    tableName: 'transactions',
    columnName: 'notes',
    totalRows: 0,
    encryptedRows: 0,
    unencryptedRows: 0,
    errors: 0,
  };

  try {
    const result = await queryRead(`
      SELECT id, notes FROM transactions 
      WHERE notes IS NOT NULL AND notes != ''
      ORDER BY created_at DESC
      LIMIT 10000
    `);

    stats.totalRows = result.rows.length;
    logger.info(`Found ${stats.totalRows} transactions with notes`);

    for (const row of result.rows) {
      try {
        if (isAlreadyEncrypted(row.notes)) {
          stats.encryptedRows++;
          continue;
        }

        const encrypted = encrypt(row.notes);
        await queryWrite(
          'UPDATE transactions SET notes = $1, updated_at = NOW() WHERE id = $2',
          [encrypted, row.id]
        );

        stats.unencryptedRows++;
        logger.debug(`Encrypted notes for transaction ${row.id}`);
      } catch (error) {
        stats.errors++;
        logger.error(error, `Failed to encrypt notes for transaction ${row.id}`);
      }
    }

    logger.info(`Notes migration complete: ${stats.unencryptedRows} encrypted, ${stats.encryptedRows} already encrypted, ${stats.errors} errors`);
  } catch (error) {
    logger.error(error, 'Failed to migrate transaction notes');
    throw error;
  }

  return stats;
}

/**
 * Main migration function
 */
async function main(): Promise<void> {
  logger.info('Starting encryption migration for existing data...');
  logger.info('This migration will encrypt any plaintext data in sensitive transaction fields.');

  const startTime = Date.now();
  const allStats: MigrationStats[] = [];

  try {
    // Run migrations in sequence
    allStats.push(await encryptTransactionPhoneNumbers());
    allStats.push(await encryptTransactionStellarAddresses());
    allStats.push(await encryptTransactionNotes());

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    // Print summary
    logger.info('=== Migration Summary ===');
    let totalEncrypted = 0;
    let totalAlreadyEncrypted = 0;
    let totalErrors = 0;

    for (const stats of allStats) {
      logger.info(`${stats.tableName}.${stats.columnName}: ${stats.unencryptedRows} encrypted, ${stats.encryptedRows} already encrypted, ${stats.errors} errors`);
      totalEncrypted += stats.unencryptedRows;
      totalAlreadyEncrypted += stats.encryptedRows;
      totalErrors += stats.errors;
    }

    logger.info(`Total: ${totalEncrypted} encrypted, ${totalAlreadyEncrypted} already encrypted, ${totalErrors} errors`);
    logger.info(`Migration completed in ${duration.toFixed(2)} seconds`);

    if (totalErrors > 0) {
      logger.warn(`Migration completed with ${totalErrors} errors. Check logs for details.`);
    }
  } catch (error) {
    logger.error(error, 'Migration failed');
    process.exit(1);
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

export { main as encryptExistingData };
