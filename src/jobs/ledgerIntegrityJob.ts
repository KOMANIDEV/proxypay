import { pool } from "../config/database";
import { LEDGER_INTEGRITY_JOB_ENABLED } from "../config/env";
import { ledgerModel } from "../models/ledger";
import { ledgerService } from "../services/ledgerService";
import { notifySlackAlert } from "../services/loggers";
import { ledgerIntegrityScore } from "../utils/metrics";

interface UnbalancedTransaction {
  reference_number: string;
  total_debits: number;
  total_credits: number;
  difference: number;
}

async function findUnbalancedTransactions(): Promise<UnbalancedTransaction[]> {
  const result = await pool.query<{
    reference_number: string;
    total_debits: string;
    total_credits: string;
    difference: string;
  }>(
    `SELECT
       reference_number,
       SUM(debit_amount) AS total_debits,
       SUM(credit_amount) AS total_credits,
       SUM(debit_amount) - SUM(credit_amount) AS difference
     FROM ledger_entries
     GROUP BY reference_number
     HAVING ABS(SUM(debit_amount) - SUM(credit_amount)) > 0.0000001`,
  );

  return result.rows.map((row) => ({
    reference_number: row.reference_number,
    total_debits: Number(row.total_debits),
    total_credits: Number(row.total_credits),
    difference: Number(row.difference),
  }));
}

function calculateIntegrityScore(
  unbalancedCount: number,
  totalTransactions: number,
): number {
  if (totalTransactions === 0) {
    return 100;
  }
  return Math.max(0, 100 - (unbalancedCount / totalTransactions) * 100);
}

export async function runLedgerIntegrityJob(): Promise<void> {
  console.info("[ledger-integrity] Starting ledger entry validation job");

  if (!LEDGER_INTEGRITY_JOB_ENABLED) {
    console.info(
      "[ledger-integrity] Skipping because LEDGER_INTEGRITY_JOB_ENABLED=false",
    );
    return;
  }

  try {
    const balanceCheck = await ledgerService.checkLedgerBalance();
    const unbalancedTransactions = await findUnbalancedTransactions();
    const stats = await ledgerModel.getLedgerStatistics();

    const integrityScore = calculateIntegrityScore(
      unbalancedTransactions.length,
      stats.unique_transactions,
    );

    ledgerIntegrityScore.set(integrityScore);

    await pool.query(
      `INSERT INTO ledger_integrity_reports
        (is_balanced, total_debits, total_credits, difference, unbalanced_transaction_count, integrity_score, discrepancies)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        balanceCheck.is_balanced,
        balanceCheck.total_debits,
        balanceCheck.total_credits,
        balanceCheck.difference,
        unbalancedTransactions.length,
        integrityScore,
        JSON.stringify(unbalancedTransactions.slice(0, 100)),
      ],
    );

    if (!balanceCheck.is_balanced || unbalancedTransactions.length > 0) {
      console.warn(
        `[ledger-integrity] ALERT: difference=${balanceCheck.difference}, unbalanced_transactions=${unbalancedTransactions.length}, integrity_score=${integrityScore.toFixed(2)}`,
      );

      await notifySlackAlert(
        {
          statusCode: 500,
          method: "MONITOR",
          path: "/ledger/integrity",
          timestamp: new Date().toISOString(),
          error: new Error(
            `Ledger integrity alert: difference=${balanceCheck.difference.toFixed(
              7,
            )}, ${unbalancedTransactions.length} unbalanced transaction(s), integrity score=${integrityScore.toFixed(
              2,
            )}. Run 'npm run reconcile:ledger' for a full report.`,
          ),
        },
        { appName: "ledger-integrity" },
      );
    } else {
      console.info(
        `[ledger-integrity] Ledger is balanced. integrity_score=${integrityScore.toFixed(2)}`,
      );
    }
  } catch (error) {
    console.error(
      "[ledger-integrity] Failed to complete ledger integrity validation:",
      error,
    );
    throw error;
  }
}
