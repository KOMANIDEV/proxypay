import { pool } from "../config/database";

/**
 * Status Check Job
 * Schedule: Every hour (0 * * * *)
 * Flags transactions stuck in 'pending' longer than STUCK_TRANSACTION_MINUTES (default: 60).
 */
export async function runStatusCheckJob(): Promise<void> {
  const thresholdMinutes = parseInt(
    process.env.STUCK_TRANSACTION_MINUTES || "60",
    10,
  );

  const result = await pool.query(
    `SELECT id, reference_number, created_at
     FROM transactions
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '${thresholdMinutes} minutes'`,
  );

  if (result.rows.length === 0) {
    console.log("[status-check] No stuck transactions found");
    return;
  }

  console.warn(
    `[status-check] ${result.rows.length} stuck pending transaction(s):`,
  );
  for (const row of result.rows) {
    console.warn(
      `[status-check]   id=${row.id} ref=${row.reference_number} created_at=${row.created_at}`,
    );
  }
}
