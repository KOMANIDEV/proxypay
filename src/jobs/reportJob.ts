import { pool } from "../config/database";

/**
 * Report Generation Job
 * Schedule: Daily at 6:00 AM (0 6 * * *)
 * Generates a daily summary report for the previous day's transactions.
 */
export async function runReportJob(): Promise<void> {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  const reportDate = date.toISOString().split("T")[0];

  const result = await pool.query(`
    SELECT
      status,
      type,
      COUNT(*)::int        AS count,
      SUM(amount::numeric) AS total_amount
    FROM transactions
    WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
      AND created_at <  CURRENT_DATE
    GROUP BY status, type
    ORDER BY type, status
  `);

  const userFeesResult = await pool.query(
    `SELECT COALESCE(SUM(fee_amount), 0)::numeric AS total_user_fees
     FROM transactions
     WHERE DATE(created_at) = $1`,
    [reportDate],
  );

  const providerFeesResult = await pool.query(
    `SELECT COALESCE(SUM(provider_fee), 0)::numeric AS total_provider_fees
     FROM transactions
     WHERE DATE(created_at) = $1`,
    [reportDate],
  );

  const totalUserFees = Number(
    userFeesResult?.rows?.[0]?.total_user_fees ?? 0,
  );
  const totalProviderFees = Number(
    providerFeesResult?.rows?.[0]?.total_provider_fees ?? 0,
  );
  const pnl = totalUserFees - totalProviderFees;

  await pool.query(
    `INSERT INTO daily_pnl_snapshots (report_date, user_fees, provider_fees, pnl)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (report_date) DO UPDATE
       SET user_fees = EXCLUDED.user_fees,
           provider_fees = EXCLUDED.provider_fees,
           pnl = EXCLUDED.pnl`,
    [reportDate, totalUserFees, totalProviderFees, pnl],
  );

  if (result.rows.length === 0) {
    console.log(`[report] ${reportDate}: No transactions found`);
    return;
  }

  console.log(`[report] Daily report for ${reportDate}:`);
  for (const row of result.rows) {
    console.log(
      `[report]   ${row.type} | ${row.status}: ${row.count} transaction(s), total ${row.total_amount}`,
    );
  }
}
