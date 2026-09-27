/**
 * Travel Rule Compliance Audit Report
 * Monthly summary of Travel Rule (FATF Rec. 16) data collection coverage
 * for regulatory review. Contains no PII — only counts and identifiers.
 */

import { Parser as CsvParser } from "json2csv";
import PDFDocument from "pdfkit";
import { pool } from "../config/database";
import { TRAVEL_RULE_THRESHOLD_USD } from "../compliance/travelRule";

export interface MissedTravelRuleTransaction {
  transactionId: string;
  referenceNumber: string;
  amount: number;
  currency: string;
  provider: string;
  createdAt: string;
}

export interface TravelRuleAuditReport {
  periodStart: string;
  periodEnd: string;
  thresholdUsd: number;
  totalEligibleTransactions: number;
  capturedTransactions: number;
  missedTransactions: MissedTravelRuleTransaction[];
  coveragePercent: number;
  correctiveAction: string;
}

/**
 * Computes Travel Rule coverage for deposits >= the reporting threshold
 * within [periodStart, periodEnd). A transaction counts as "captured" when
 * a matching travel_rule_records entry exists.
 */
export async function computeTravelRuleAuditReport(
  periodStart: Date,
  periodEnd: Date,
): Promise<TravelRuleAuditReport> {
  const result = await pool.query<{
    id: string;
    reference_number: string;
    amount: string;
    currency: string;
    provider: string;
    created_at: Date;
    captured: boolean;
  }>(
    `SELECT
       t.id, t.reference_number, t.amount, t.currency, t.provider, t.created_at,
       (r.id IS NOT NULL) AS captured
     FROM transactions t
     LEFT JOIN travel_rule_records r ON r.transaction_id = t.id
     WHERE t.type = 'deposit'
       AND t.status = 'completed'
       AND t.amount >= $1
       AND t.created_at >= $2
       AND t.created_at < $3
     ORDER BY t.created_at ASC`,
    [TRAVEL_RULE_THRESHOLD_USD, periodStart, periodEnd],
  );

  const rows = result.rows;
  const missedTransactions: MissedTravelRuleTransaction[] = rows
    .filter((row) => !row.captured)
    .map((row) => ({
      transactionId: row.id,
      referenceNumber: row.reference_number,
      amount: Number(row.amount),
      currency: row.currency,
      provider: row.provider,
      createdAt: row.created_at.toISOString(),
    }));

  const totalEligibleTransactions = rows.length;
  const capturedTransactions = totalEligibleTransactions - missedTransactions.length;
  const coveragePercent =
    totalEligibleTransactions === 0
      ? 100
      : Number(((capturedTransactions / totalEligibleTransactions) * 100).toFixed(2));

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    thresholdUsd: TRAVEL_RULE_THRESHOLD_USD,
    totalEligibleTransactions,
    capturedTransactions,
    missedTransactions,
    coveragePercent,
    correctiveAction:
      missedTransactions.length > 0
        ? `${missedTransactions.length} transaction(s) missing Travel Rule data — flagged for manual compliance backfill.`
        : "No corrective action required.",
  };
}

/** Renders the missed-transactions detail as CSV for regulatory export. */
export function toCsv(report: TravelRuleAuditReport): string {
  const parser = new CsvParser({
    fields: ["transactionId", "referenceNumber", "amount", "currency", "provider", "createdAt"],
  });
  return parser.parse(report.missedTransactions);
}

/** Renders the report summary as a one-page PDF for regulatory export. */
export function toPdfBuffer(report: TravelRuleAuditReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    doc.fillColor("#2c3e50").fontSize(18).text("ProxyPay", { align: "center" });
    doc.moveDown(0.25);
    doc.fontSize(12).fillColor("#7f8c8d").text("Travel Rule Compliance Audit Report", {
      align: "center",
    });
    doc.moveDown(1);

    doc.fillColor("#34495e").fontSize(12).text("Report Period", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000");
    doc.text(`From: ${report.periodStart}`);
    doc.text(`To: ${report.periodEnd}`);
    doc.text(`Travel Rule Threshold: $${report.thresholdUsd}`);

    doc.moveDown(1);
    doc.fillColor("#34495e").fontSize(12).text("Coverage Summary", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000");
    doc.text(`Eligible Transactions: ${report.totalEligibleTransactions}`);
    doc.text(`Captured Transactions: ${report.capturedTransactions}`);
    doc.text(`Missed Transactions: ${report.missedTransactions.length}`);
    doc.text(`Coverage: ${report.coveragePercent}%`);

    doc.moveDown(1);
    doc.fillColor("#34495e").fontSize(12).text("Corrective Action", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000").text(report.correctiveAction, { width: 500 });

    doc.moveDown(2);
    doc.fillColor("#999").fontSize(9).text(
      `Generated at ${new Date().toISOString()}`,
      { align: "center" },
    );

    doc.end();
  });
}

/** Returns the default reporting period: the previous full calendar month. */
export function previousCalendarMonth(reference: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  return { start, end };
}
