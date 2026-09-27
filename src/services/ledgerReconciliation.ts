import { pool } from "../config/database";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiscrepancyRecord {
  id: string;
  account_code: string;
  expected_debits: number;
  actual_debits: number;
  expected_credits: number;
  actual_credits: number;
  difference: number;
  severity: "minor" | "moderate" | "major";
  status: "pending" | "auto_resolved" | "needs_review" | "resolved";
  detected_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
}

export interface ReconciliationResult {
  run_id: string;
  total_accounts: number;
  balanced_accounts: number;
  discrepancy_count: number;
  auto_resolved: number;
  needs_review: number;
  total_difference: number;
  started_at: string;
  completed_at: string;
  discrepancies: DiscrepancyRecord[];
}

export interface LedgerHealthSummary {
  total_accounts: number;
  balanced_accounts: number;
  unbalanced_accounts: number;
  total_debits: number;
  total_credits: number;
  difference: number;
  is_balanced: boolean;
  last_reconciliation: string | null;
  pending_reviews: number;
}

const MINOR_DISCREPANCY_THRESHOLD = parseFloat(
  process.env.RECONCILIATION_MINOR_THRESHOLD || "0.01",
);
const MAJOR_DISCREPANCY_THRESHOLD = parseFloat(
  process.env.RECONCILIATION_MAJOR_THRESHOLD || "10.00",
);

// ─── Reconciliation Engine ───────────────────────────────────────────────────

export async function runReconciliation(): Promise<ReconciliationResult> {
  const runId = `recon_${Date.now()}`;
  const startedAt = new Date().toISOString();

  const client = await pool.connect();

  try {
    // Get all account balances
    const balanceResult = await client.query(`
      SELECT
        code AS account_code,
        COALESCE(SUM(debit_amount), 0) AS total_debits,
        COALESCE(SUM(cast(credit_amount AS numeric)), 0) AS total_credits
      FROM ledger_entries
      GROUP BY code
      ORDER BY code
    `);

    const discrepancies: DiscrepancyRecord[] = [];
    let autoResolved = 0;
    let needsReview = 0;
    let totalDifference = 0;

    for (const row of balanceResult.rows) {
      const debits = parseFloat(row.total_debits);
      const credits = parseFloat(row.total_credits);
      const diff = Math.abs(debits - credits);

      if (diff > 0) {
        totalDifference += diff;

        let severity: "minor" | "moderate" | "major";
        if (diff <= MINOR_DISCREPANCY_THRESHOLD) {
          severity = "minor";
        } else if (diff <= MAJOR_DISCREPANCY_THRESHOLD) {
          severity = "moderate";
        } else {
          severity = "major";
        }

        let status: "pending" | "auto_resolved" | "needs_review";
        let resolutionNotes: string | null = null;

        if (severity === "minor") {
          status = "auto_resolved";
          resolutionNotes = `Auto-resolved: minor discrepancy of ${diff.toFixed(4)} within threshold of ${MINOR_DISCREPANCY_THRESHOLD}`;
          autoResolved++;
        } else {
          status = "needs_review";
          needsReview++;
        }

        const discrepancy: DiscrepancyRecord = {
          id: `${runId}_${row.account_code}`,
          account_code: row.account_code,
          expected_debits: debits,
          actual_debits: debits,
          expected_credits: credits,
          actual_credits: credits,
          difference: diff,
          severity,
          status,
          detected_at: startedAt,
          resolved_at: status === "auto_resolved" ? new Date().toISOString() : null,
          resolution_notes: resolutionNotes,
        };

        discrepancies.push(discrepancy);

        await client.query(
          `INSERT INTO ledger_discrepancies
            (id, account_code, expected_debits, actual_debits, expected_credits,
             actual_credits, difference, severity, status, detected_at,
             resolved_at, resolution_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            discrepancy.id,
            discrepancy.account_code,
            discrepancy.expected_debits,
            discrepancy.actual_debits,
            discrepancy.expected_credits,
            discrepancy.actual_credits,
            discrepancy.difference,
            discrepancy.severity,
            discrepancy.status,
            discrepancy.detected_at,
            discrepancy.resolved_at,
            discrepancy.resolution_notes,
          ],
        );

        // Notify via notifications table for needs_review items
        if (status === "needs_review") {
          await client.query(
            `INSERT INTO ledger_notifications
              (type, account_code, severity, message, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              "discrepancy",
              row.account_code,
              severity,
              `Discrepancy detected in account ${row.account_code}: debits ${debits} vs credits ${credits} (diff: ${diff.toFixed(4)})`,
              startedAt,
            ],
          );
        }
      }
    }

    // Log reconciliation run
    await client.query(
      `INSERT INTO ledger_reconciliation_runs
        (run_id, total_accounts, balanced_accounts, discrepancy_count,
         auto_resolved, needs_review, total_difference, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        runId,
        balanceResult.rows.length,
        balanceResult.rows.length - discrepancies.length,
        discrepancies.length,
        autoResolved,
        needsReview,
        totalDifference,
        startedAt,
        new Date().toISOString(),
      ],
    );

    return {
      run_id: runId,
      total_accounts: balanceResult.rows.length,
      balanced_accounts: balanceResult.rows.length - discrepancies.length,
      discrepancy_count: discrepancies.length,
      auto_resolved: autoResolved,
      needs_review: needsReview,
      total_difference: totalDifference,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      discrepancies,
    };
  } finally {
    client.release();
  }
}

// ─── Health Summary ───────────────────────────────────────────────────────────

export async function getLedgerHealthSummary(): Promise<LedgerHealthSummary> {
  const client = await pool.connect();

  try {
    const balanceResult = await client.query(`
      SELECT
        COUNT(DISTINCT code) AS total_accounts,
        COALESCE(SUM(debit_amount), 0) AS total_debits,
        COALESCE(SUM(cast(credit_amount AS numeric)), 0) AS total_credits
      FROM ledger_entries
    `);

    const row = balanceResult.rows[0];
    const totalDebits = parseFloat(row.total_debits);
    const totalCredits = parseFloat(row.total_credits);
    const diff = Math.abs(totalDebits - totalCredits);

    const unbalancedResult = await client.query(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT code
        FROM ledger_entries
        GROUP BY code
        HAVING ABS(COALESCE(SUM(debit_amount), 0) - COALESCE(SUM(cast(credit_amount AS numeric)), 0)) > 0.001
      ) sub
    `);

    const lastRunResult = await client.query(`
      SELECT completed_at FROM ledger_reconciliation_runs
      ORDER BY started_at DESC LIMIT 1
    `);

    const pendingResult = await client.query(`
      SELECT COUNT(*) AS cnt FROM ledger_discrepancies
      WHERE status = 'needs_review'
    `);

    return {
      total_accounts: parseInt(row.total_accounts),
      balanced_accounts: parseInt(row.total_accounts) - parseInt(unbalancedResult.rows[0].cnt),
      unbalanced_accounts: parseInt(unbalancedResult.rows[0].cnt),
      total_debits: totalDebits,
      total_credits: totalCredits,
      difference: diff,
      is_balanced: diff < 0.001,
      last_reconciliation: lastRunResult.rows[0]?.completed_at ?? null,
      pending_reviews: parseInt(pendingResult.rows[0].cnt),
    };
  } finally {
    client.release();
  }
}

// ─── Manual Reconciliation Trigger ───────────────────────────────────────────

export async function triggerManualReconciliation(
  accountCode?: string,
): Promise<ReconciliationResult | DiscrepancyRecord[]> {
  if (accountCode) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT
           code AS account_code,
           COALESCE(SUM(debit_amount), 0) AS total_debits,
           COALESCE(SUM(cast(credit_amount AS numeric)), 0) AS total_credits
         FROM ledger_entries
         WHERE code = $1
         GROUP BY code`,
        [accountCode],
      );

      if (result.rows.length === 0) {
        return [];
      }

      const row = result.rows[0];
      const debits = parseFloat(row.total_debits);
      const credits = parseFloat(row.total_credits);
      const diff = Math.abs(debits - credits);

      if (diff < MINOR_DISCREPANCY_THRESHOLD) {
        return [];
      }

      const severity = diff <= MAJOR_DISCREPANCY_THRESHOLD ? "moderate" : "major";

      const discrepancy: DiscrepancyRecord = {
        id: `manual_${Date.now()}_${accountCode}`,
        account_code: accountCode,
        expected_debits: debits,
        actual_debits: debits,
        expected_credits: credits,
        actual_credits: credits,
        difference: diff,
        severity,
        status: "needs_review",
        detected_at: new Date().toISOString(),
        resolved_at: null,
        resolution_notes: `Manual reconciliation triggered for account ${accountCode}`,
      };

      await client.query(
        `INSERT INTO ledger_discrepancies
          (id, account_code, expected_debits, actual_debits, expected_credits,
           actual_credits, difference, severity, status, detected_at,
           resolved_at, resolution_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          discrepancy.id,
          discrepancy.account_code,
          discrepancy.expected_debits,
          discrepancy.actual_debits,
          discrepancy.expected_credits,
          discrepancy.actual_credits,
          discrepancy.difference,
          discrepancy.severity,
          discrepancy.status,
          discrepancy.detected_at,
          discrepancy.resolved_at,
          discrepancy.resolution_notes,
        ],
      );

      return [discrepancy];
    } finally {
      client.release();
    }
  }

  return runReconciliation();
}
