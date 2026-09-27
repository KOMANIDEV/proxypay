import { retentionPolicyService } from "../services/retentionPolicyService";

/**
 * Retention Purge Job
 * Schedule: Daily at 1:30 AM (0 30 1 * * *) — override with RETENTION_PURGE_CRON
 * Enforces the configured retention period for each data type and writes the
 * outcome to the purge audit log.
 */
export async function runRetentionPurgeJob(): Promise<void> {
  const results = await retentionPolicyService.enforceAll();

  for (const result of results) {
    if (result.outcome === "failed") {
      console.error(
        `[retention] ${result.dataType} purge failed: ${result.error}`,
      );
      continue;
    }

    console.log(
      `[retention] ${result.dataType}: ${result.outcome}, ${result.recordsAffected} record(s) purged (retention ${result.retentionDays} days)`,
    );
  }
}
