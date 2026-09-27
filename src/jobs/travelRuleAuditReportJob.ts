import {
  computeTravelRuleAuditReport,
  previousCalendarMonth,
  toCsv,
  toPdfBuffer,
} from "../reports/travelRuleAuditReport";
import { uploadToS3 } from "../services/s3Upload";

/**
 * Travel Rule Compliance Audit Report Job
 * Schedule: Monthly on the 2nd at 5:00 AM
 * Generates the previous month's Travel Rule coverage report and exports it
 * as CSV + PDF for regulatory review.
 */
export async function runTravelRuleAuditReportJob(): Promise<void> {
  const { start, end } = previousCalendarMonth();
  const report = await computeTravelRuleAuditReport(start, end);

  const periodLabel = start.toISOString().slice(0, 7); // YYYY-MM
  const csv = toCsv(report);
  const pdfBuffer = await toPdfBuffer(report);

  const [csvUpload, pdfUpload] = await Promise.all([
    uploadToS3({
      userId: "system",
      file: {
        buffer: Buffer.from(csv, "utf8"),
        originalname: `travel-rule-audit-${periodLabel}.csv`,
        mimetype: "text/csv",
        size: Buffer.byteLength(csv),
        fieldname: "file",
        encoding: "7bit",
      } as Express.Multer.File,
      metadata: { reportType: "travel-rule-audit", period: periodLabel },
    }),
    uploadToS3({
      userId: "system",
      file: {
        buffer: pdfBuffer,
        originalname: `travel-rule-audit-${periodLabel}.pdf`,
        mimetype: "application/pdf",
        size: pdfBuffer.length,
        fieldname: "file",
        encoding: "7bit",
      } as Express.Multer.File,
      metadata: { reportType: "travel-rule-audit", period: periodLabel },
    }),
  ]);

  console.log(
    `[travel-rule-audit-report] ${periodLabel}: coverage=${report.coveragePercent}% ` +
      `eligible=${report.totalEligibleTransactions} missed=${report.missedTransactions.length} ` +
      `csv=${csvUpload.fileUrl ?? "upload-failed"} pdf=${pdfUpload.fileUrl ?? "upload-failed"}`,
  );
}
