import { sanctionService } from "../services/sanctionService";
import { pool } from "../config/database";
import {
  sanctionsListLastUpdateTimestamp,
  sanctionsListRecordCount,
  sanctionsSyncFailuresTotal,
} from "../utils/metrics";

/**
 * Background job to fetch and sync global sanction lists.
 * Runs daily to ensure AML screening is based on the latest data.
 */
export async function runSanctionSyncJob(): Promise<void> {
  console.log("[sanction-sync] Starting daily sanction list synchronization...");

  try {
    const updates = await sanctionService.fetchSanctionUpdates();
    console.log(`[sanction-sync] Fetched ${updates.length} entities from global lists.`);

    await sanctionService.updateSanctionList(updates);

    const countResult = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::int AS count FROM sanction_list",
    );
    const recordCount = Number(countResult.rows[0]?.count ?? 0);

    sanctionsListLastUpdateTimestamp.set(Date.now() / 1000);
    sanctionsListRecordCount.set(recordCount);

    console.log(
      `[sanction-sync] Successfully updated internal sanction blacklist (${recordCount} records).`,
    );
  } catch (error) {
    sanctionsSyncFailuresTotal.inc();
    console.error("[sanction-sync] Critical failure during sanction sync:", error);
    throw error;
  }
}
