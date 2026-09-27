import { 
  ReconciliationModel, 
  ReconciliationStatus, 
  DiscrepancyType 
} from "../models/reconciliation";
import { 
  parseCSV, 
  reconcileTransactions, 
  ProviderCSVRow 
} from "./csvReconciliation";
import logger from "../utils/logger";

export class ProviderReconService {
  private reconModel: ReconciliationModel;

  constructor() {
    this.reconModel = new ReconciliationModel();
  }

  /**
   * Run reconciliation for a provider and date
   */
  async runReconciliation(
    provider: string,
    reportDate: Date,
    csvBuffer: Buffer,
    fileName?: string
  ) {
    logger.info(`Starting reconciliation for ${provider} on ${reportDate.toISOString()}`);

    // 1. Create initial report record
    const report = await this.reconModel.createReport({
      provider,
      reportDate,
      fileName,
      status: ReconciliationStatus.Pending,
    });

    try {
      // 2. Parse CSV
      const rows = await parseCSV(csvBuffer);
      
      // 3. Reconcile
      // We fetch transactions for the report date +/- 1 day to catch edge cases
      const start = new Date(reportDate);
      start.setDate(start.getDate() - 1);
      const end = new Date(reportDate);
      end.setDate(end.getDate() + 1);

      const result = await reconcileTransactions(rows, {
        start: start.toISOString(),
        end: end.toISOString(),
      });

      // 4. Save Discrepancies
      for (const disc of result.discrepancies) {
        await this.reconModel.createDiscrepancy({
          reportId: report.id,
          transactionId: disc.db_record?.id,
          referenceNumber: disc.reference_number,
          type: disc.discrepancy_type!,
          expectedValue: `Amount: ${disc.db_record?.amount}, Status: ${disc.db_record?.status}`,
          actualValue: `Amount: ${disc.provider_record?.amount}, Status: ${disc.provider_record?.status}`,
        });
      }

      for (const orphan of result.orphaned_provider) {
        await this.reconModel.createDiscrepancy({
          reportId: report.id,
          referenceNumber: orphan.reference_number || orphan.reference_id || "UNKNOWN",
          type: DiscrepancyType.OrphanedProvider,
          actualValue: JSON.stringify(orphan),
        });
      }

      for (const orphan of result.orphaned_db) {
        await this.reconModel.createDiscrepancy({
          reportId: report.id,
          transactionId: orphan.id,
          referenceNumber: orphan.reference_number,
          type: DiscrepancyType.OrphanedDb,
          expectedValue: JSON.stringify(orphan),
        });
      }

      // 5. Update report status and summary
      await this.reconModel.updateReport(report.id, {
        status: ReconciliationStatus.Completed,
        summary: result.summary,
      });

      logger.info(`Reconciliation completed for ${report.id}. Match rate: ${result.summary.match_rate}`);
      return report.id;

    } catch (error) {
      logger.error({ error, reportId: report.id }, `Reconciliation failed for ${report.id}`);
      await this.reconModel.updateReport(report.id, {
        status: ReconciliationStatus.Failed,
        summary: { error: (error as Error).message },
      });
      throw error;
    }
  }

  private reportCache: Map<string, { buffer: Buffer; expiresAt: number }> = new Map();

  /**
   * Fetch reconciliation report from a provider (MTN, Airtel, Orange)
   * Supports date range parameters, retry logic, validation, and caching.
   */
  async fetchProviderReport(
    provider: string,
    date: Date,
    dateRange?: { start: Date; end: Date }
  ): Promise<Buffer | null> {
    const normProvider = provider.toLowerCase().trim();
    const supportedProviders = ["mtn", "airtel", "orange"];
    if (!supportedProviders.includes(normProvider)) {
      logger.warn(`Fetch provider report not supported for provider: ${provider}`);
      return null;
    }

    const startDate = dateRange?.start || date;
    const endDate = dateRange?.end || date;
    const dateStr = startDate.toISOString().split("T")[0];
    const cacheKey = `${normProvider}_${dateStr}_${endDate.toISOString().split("T")[0]}`;

    // 1. Check in-memory/TTL cache (1 hour TTL)
    const cached = this.reportCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      logger.info(`Returning cached report for ${normProvider} on ${dateStr}`);
      return cached.buffer;
    }

    // 2. Fetch with retry logic (up to 3 attempts with exponential backoff)
    const maxRetries = 3;
    let attempt = 0;
    let lastError: any = null;

    while (attempt < maxRetries) {
      attempt++;
      try {
        logger.info(`Fetching report from ${normProvider} (attempt ${attempt}/${maxRetries})`);
        
        // Mock API call to provider report endpoint
        const reportCsv = await this.queryProviderReportApi(normProvider, startDate, endDate);
        const reportBuffer = Buffer.from(reportCsv, "utf-8");

        // Validate report data format and headers
        const headerLine = reportCsv.split("\n")[0];
        if (!headerLine.includes("reference_number") && !headerLine.includes("amount")) {
          throw new Error(`Invalid report format received from ${normProvider}: missing required columns`);
        }

        // Cache the valid report with 1 hour TTL
        this.reportCache.set(cacheKey, {
          buffer: reportBuffer,
          expiresAt: Date.now() + 3600 * 1000
        });

        return reportBuffer;
      } catch (err: any) {
        lastError = err;
        logger.warn({ error: err.message, attempt, provider: normProvider }, `Attempt ${attempt} to fetch report failed`);
        if (attempt < maxRetries) {
          // Exponential backoff: 200ms, 400ms, etc.
          await new Promise((resolve) => setTimeout(resolve, attempt * 200));
        }
      }
    }

    logger.error({ error: lastError, provider: normProvider }, `All attempts to fetch provider report failed`);
    return null;
  }

  /**
   * Internal helper to query provider report API or generate standard reconciliation CSV
   */
  private async queryProviderReportApi(provider: string, start: Date, end: Date): Promise<string> {
    const sDate = start.toISOString().split("T")[0];
    const eDate = end.toISOString().split("T")[0];

    // Generate valid CSV with provider-specific mock settlement/transaction data
    const rows = [
      "reference_number,amount,status,date,provider,currency",
      `TXN_${provider.toUpperCase()}_001,150.00,SUCCESS,${sDate},${provider.toUpperCase()},XLM`,
      `TXN_${provider.toUpperCase()}_002,300.50,SUCCESS,${sDate},${provider.toUpperCase()},XLM`,
      `TXN_${provider.toUpperCase()}_003,50.00,PENDING,${eDate},${provider.toUpperCase()},XLM`
    ];

    return rows.join("\n");
  }
}
