import {
  listBackups,
  getBackupMetadata,
  validateBackupIntegrity,
  verifyDataSafety,
} from "../services/backupService";
import { createPagerDutyService } from "../services/pagerDutyService";

const pagerDutyService = createPagerDutyService();

/**
 * Scheduled Database Backup Verification Job
 * Automatically triggered by node-cron scheduler to assert latest backup's integrity.
 */
export async function runDatabaseBackupVerifyJob(): Promise<void> {
  console.log("[backup-verify-job] Starting scheduled database backup verification...");
  try {
    const safety = await verifyDataSafety();
    if (!safety.safe) {
      const errorMessage = "Data safety verification failed. Backups may be missing or bucket inaccessible.";
      console.error(`[backup-verify-job] ${errorMessage}`);
      await pagerDutyService.sendEvent({
        routing_key: process.env.PAGERDUTY_INTEGRATION_KEY || "",
        event_action: "trigger",
        dedup_key: "proxypay-backup-data-safety",
        payload: {
          summary: "[CRITICAL] Database backup data safety verification failed",
          timestamp: new Date().toISOString(),
          severity: "critical",
          source: "proxypay-backup-job",
          custom_details: {
            error: errorMessage,
            job: "database-backup-verify",
          },
        },
      });
      throw new Error(errorMessage);
    }

    const backups = await listBackups();
    if (backups.length === 0) {
      const errorMessage = "No backups found in S3 to verify.";
      console.warn(`[backup-verify-job] ${errorMessage}`);
      await pagerDutyService.sendEvent({
        routing_key: process.env.PAGERDUTY_INTEGRATION_KEY || "",
        event_action: "trigger",
        dedup_key: "proxypay-backup-no-backups",
        payload: {
          summary: "[WARNING] No database backups found to verify",
          timestamp: new Date().toISOString(),
          severity: "warning",
          source: "proxypay-backup-job",
          custom_details: {
            error: errorMessage,
            job: "database-backup-verify",
          },
        },
      });
      return;
    }

    const latest = backups[0];
    console.log(`[backup-verify-job] Verifying latest backup: ${latest.backupId}`);
    
    const metadata = await getBackupMetadata(latest.backupId);
    const passed = await validateBackupIntegrity(latest.backupId, metadata);

    if (!passed) {
      const errorMessage = `Backup integrity validation failed for backup ID: ${latest.backupId}`;
      console.error(`[backup-verify-job] ${errorMessage}`);
      await pagerDutyService.sendEvent({
        routing_key: process.env.PAGERDUTY_INTEGRATION_KEY || "",
        event_action: "trigger",
        dedup_key: `proxypay-backup-verify-${latest.backupId}`,
        payload: {
          summary: `[CRITICAL] Database backup verification failed for ${latest.backupId}`,
          timestamp: new Date().toISOString(),
          severity: "critical",
          source: "proxypay-backup-job",
          custom_details: {
            backup_id: latest.backupId,
            error: errorMessage,
            job: "database-backup-verify",
          },
        },
      });
      throw new Error(errorMessage);
    }

    console.log(`[backup-verify-job] Database backup verification successful for ${latest.backupId}`);
  } catch (error) {
    console.error("[backup-verify-job] Unhandled error during backup verification:", error);
    throw error;
  }
}
