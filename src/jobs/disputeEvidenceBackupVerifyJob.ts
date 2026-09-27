/**
 * Dispute Evidence Backup Verification Job (#629)
 *
 * Runs daily to verify that dispute evidence files recently uploaded to the
 * primary S3 bucket are present in the backup bucket.  Any missing files are
 * logged as errors and can trigger alerting via the monitoring service.
 *
 * Schedule: Daily at 03:00 UTC ("0 3 * * *")
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getS3Client, s3Config } from '../config/s3';
import {
  DISPUTE_EVIDENCE_BACKUP_BUCKET,
  getBackupS3Client,
  verifyDisputeEvidenceBackup,
} from '../services/disputeS3Upload';

export interface BackupVerificationResult {
  checkedCount: number;
  missingCount: number;
  missingKeys: string[];
  passed: boolean;
  checkedAt: string;
}

/**
 * Lists all dispute evidence keys uploaded within the last `lookbackHours`
 * hours from the primary bucket.
 */
async function listRecentEvidenceKeys(
  primaryClient: S3Client,
  lookbackHours: number,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await primaryClient.send(
      new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        Prefix: 'disputes/',
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of response.Contents ?? []) {
      if (obj.Key && obj.LastModified && obj.LastModified >= cutoff) {
        keys.push(obj.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

/**
 * Verifies that all dispute evidence files uploaded in the last 25 hours
 * are present in the backup bucket.
 *
 * Returns a verification result object.  Logs errors for any missing keys so
 * that log-based alerting can surface them.
 */
export async function runDisputeEvidenceBackupVerifyJob(
  lookbackHours = 25,
): Promise<BackupVerificationResult> {
  const checkedAt = new Date().toISOString();
  console.log('[dispute-backup-verify] Starting backup verification job...');

  const primaryClient = getS3Client();

  let recentKeys: string[];
  try {
    recentKeys = await listRecentEvidenceKeys(primaryClient, lookbackHours);
  } catch (err) {
    console.error('[dispute-backup-verify] Failed to list primary bucket objects:', err);
    return { checkedCount: 0, missingCount: 0, missingKeys: [], passed: false, checkedAt };
  }

  if (recentKeys.length === 0) {
    console.log('[dispute-backup-verify] No recent dispute evidence found — nothing to verify.');
    return { checkedCount: 0, missingCount: 0, missingKeys: [], passed: true, checkedAt };
  }

  const missingKeys: string[] = [];

  for (const key of recentKeys) {
    const exists = await verifyDisputeEvidenceBackup(key);
    if (!exists) {
      missingKeys.push(key);
      console.error(`[dispute-backup-verify] MISSING backup for key: ${key}`);
    }
  }

  const passed = missingKeys.length === 0;

  if (passed) {
    console.log(
      `[dispute-backup-verify] ✅ All ${recentKeys.length} recent evidence file(s) verified in backup bucket.`,
    );
  } else {
    console.error(
      `[dispute-backup-verify] ❌ ${missingKeys.length}/${recentKeys.length} evidence file(s) missing from backup bucket!`,
    );
  }

  return {
    checkedCount: recentKeys.length,
    missingCount: missingKeys.length,
    missingKeys,
    passed,
    checkedAt,
  };
}
