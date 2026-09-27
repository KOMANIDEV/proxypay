import { Readable } from "stream";
import csvParser from "csv-parser";
import { queryRead } from "../config/database";
import { DiscrepancyType } from "../models/reconciliation";

export interface ProviderCSVRow {
  reference_number?: string;
  reference_id?: string;
  provider_reference?: string;
  amount?: string;
  status?: string;
  phone_number?: string;
  provider?: string;
  [key: string]: string | undefined;
}

export interface ReconciliationMatch {
  reference_number: string;
  amount: string;
  status: string;
  provider_status?: string;
  matched: boolean;
  discrepancy_type?: DiscrepancyType;
  db_record?: {
    id: string;
    reference_number: string;
    provider_reference?: string;
    amount: string;
    status: string;
    phone_number: string;
    provider: string;
    created_at: string;
  };
  provider_record?: ProviderCSVRow;
}

export interface ReconciliationResult {
  total_provider_rows: number;
  total_db_records: number;
  matched: ReconciliationMatch[];
  discrepancies: ReconciliationMatch[];
  orphaned_provider: ProviderCSVRow[];
  orphaned_db: {
    id: string;
    reference_number: string;
    amount: string;
    status: string;
    phone_number: string;
    provider: string;
    created_at: string;
  }[];
  summary: {
    match_rate: string;
    total_matched: number;
    total_discrepancies: number;
    total_orphaned_provider: number;
    total_orphaned_db: number;
  };
}

/**
 * Parse CSV buffer into array of objects
 */
export async function parseCSV(buffer: Buffer): Promise<ProviderCSVRow[]> {
  return new Promise((resolve, reject) => {
    const results: ProviderCSVRow[] = [];
    const stream = Readable.from(buffer);

    stream
      .pipe(csvParser())
      .on("data", (data: ProviderCSVRow) => {
        // Trim all string values
        const trimmedData: ProviderCSVRow = {};
        for (const [key, value] of Object.entries(data)) {
          trimmedData[key] = typeof value === "string" ? value.trim() : value;
        }
        if (Object.keys(trimmedData).length > 0) {
          results.push(trimmedData);
        }
      })
      .on("end", () => resolve(results))
      .on("error", (error) => reject(error));
  });
}

/**
 * Normalize reference number (handle different formats)
 */
function normalizeReferenceNumber(ref?: string): string | null {
  if (!ref) return null;
  return ref.trim().toUpperCase();
}

/**
 * Normalize amount for comparison (remove currency symbols, commas)
 */
function normalizeAmount(amount?: string): string | null {
  if (!amount) return null;
  return amount.replace(/[^0-9.]/g, "").trim();
}

export interface CSVValidationError {
  row: number;
  field: string;
  value: unknown;
  message: string;
  severity: "error" | "warning";
}

export interface CSVValidationResult {
  isValid: boolean;
  errors: CSVValidationError[];
  warnings: CSVValidationError[];
  summary: {
    totalRows: number;
    validRows: number;
    errorRows: number;
    warningRows: number;
  };
}

export interface CSVImportPreview {
  preview: ReconciliationResult;
  validation: CSVValidationResult;
  estimatedChanges: {
    matched: number;
    discrepancies: number;
    orphanedProvider: number;
    orphanedDb: number;
  };
}

export interface CSVImportRollback {
  importId: string;
  rolledBackAt: string;
  recordsRestored: number;
}

const REQUIRED_FIELDS = ["reference_number", "amount", "status", "phone_number", "provider"];
const VALID_STATUSES = ["completed", "pending", "failed", "cancelled"];
const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;
const AMOUNT_REGEX = /^\d+(\.\d+)?$/;

export function validateCSVSchema(rows: ProviderCSVRow[]): CSVValidationResult {
  const errors: CSVValidationError[] = [];
  const warnings: CSVValidationError[] = [];
  let errorRows = 0;
  let warningRows = 0;

  if (rows.length === 0) {
    return {
      isValid: true,
      errors: [],
      warnings: [],
      summary: { totalRows: 0, validRows: 0, errorRows: 0, warningRows: 0 },
    };
  }

  const sampleKeys = Object.keys(rows[0]);
  for (const field of REQUIRED_FIELDS) {
    if (!sampleKeys.includes(field) && !sampleKeys.includes("reference_id")) {
      errors.push({
        row: 0,
        field: "schema",
        value: sampleKeys,
        message: `Missing required field: ${field}`,
        severity: "error",
      });
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2;
    let rowHasError = false;
    let rowHasWarning = false;

    const ref = row.reference_number || row.reference_id;
    if (!ref || ref.trim() === "") {
      errors.push({ row: rowNumber, field: "reference_number", value: ref, message: "Reference number is required", severity: "error" });
      rowHasError = true;
    }

    if (!row.amount || row.amount.trim() === "") {
      errors.push({ row: rowNumber, field: "amount", value: row.amount, message: "Amount is required", severity: "error" });
      rowHasError = true;
    } else if (!AMOUNT_REGEX.test(row.amount.trim())) {
      errors.push({ row: rowNumber, field: "amount", value: row.amount, message: "Amount must be a valid number", severity: "error" });
      rowHasError = true;
    }

    if (!row.status || row.status.trim() === "") {
      errors.push({ row: rowNumber, field: "status", value: row.status, message: "Status is required", severity: "error" });
      rowHasError = true;
    } else if (!VALID_STATUSES.includes(row.status.toLowerCase().trim())) {
      warnings.push({
        row: rowNumber,
        field: "status",
        value: row.status,
        message: `Non-standard status: ${row.status}. Expected one of: ${VALID_STATUSES.join(", ")}`,
        severity: "warning",
      });
      rowHasWarning = true;
    }

    if (!row.phone_number || row.phone_number.trim() === "") {
      errors.push({ row: rowNumber, field: "phone_number", value: row.phone_number, message: "Phone number is required", severity: "error" });
      rowHasError = true;
    } else if (!PHONE_REGEX.test(row.phone_number.trim())) {
      warnings.push({
        row: rowNumber,
        field: "phone_number",
        value: row.phone_number,
        message: "Phone number format may be invalid",
        severity: "warning",
      });
      rowHasWarning = true;
    }

    if (!row.provider || row.provider.trim() === "") {
      errors.push({ row: rowNumber, field: "provider", value: row.provider, message: "Provider is required", severity: "error" });
      rowHasError = true;
    }

    if (rowHasError) errorRows++;
    if (rowHasWarning) warningRows++;
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    summary: {
      totalRows: rows.length,
      validRows: rows.length - errorRows,
      errorRows,
      warningRows,
    },
  };
}

export async function previewCSVImport(buffer: Buffer, dateRange?: { start?: string; end?: string }): Promise<CSVImportPreview> {
  const rows = await parseCSV(buffer);
  const validation = validateCSVSchema(rows);
  const preview = validation.isValid ? await reconcileTransactions(rows, dateRange) : {
    total_provider_rows: rows.length,
    total_db_records: 0,
    matched: [],
    discrepancies: [],
    orphaned_provider: [],
    orphaned_db: [],
    summary: { match_rate: "0.00%", total_matched: 0, total_discrepancies: 0, total_orphaned_provider: 0, total_orphaned_db: 0 },
  };

  return {
    preview,
    validation,
    estimatedChanges: {
      matched: preview.summary.total_matched,
      discrepancies: preview.summary.total_discrepancies,
      orphanedProvider: preview.summary.total_orphaned_provider,
      orphanedDb: preview.summary.total_orphaned_db,
    },
  };
}

export async function rollbackCSVImport(importId: string): Promise<CSVImportRollback> {
  const result = await queryRead("SELECT * FROM csv_imports WHERE id = $1", [importId]);
  if (!result.rows.length) {
    throw new Error("Import not found");
  }

  const importRecord = result.rows[0];
  if (importRecord.rolled_back_at) {
    throw new Error("Import has already been rolled back");
  }

  let recordsRestored = 0;
  if (importRecord.backup_snapshot) {
    const snapshot = importRecord.backup_snapshot as any[];
    for (const record of snapshot) {
      await queryWrite(
        `INSERT INTO transactions (id, reference_number, amount, status, phone_number, provider, user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (reference_number) DO UPDATE SET
           amount = EXCLUDED.amount,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [record.id, record.reference_number, record.amount, record.status, record.phone_number, record.provider, record.user_id, record.created_at, record.updated_at],
      );
      recordsRestored++;
    }
  }

  await queryWrite(`UPDATE csv_imports SET rolled_back_at = NOW() WHERE id = $1`, [importId]);

  return {
    importId,
    rolledBackAt: new Date().toISOString(),
    recordsRestored,
  };
}

/**
 * Reconcile provider CSV against database transactions
 */
export async function reconcileTransactions(
  providerRows: ProviderCSVRow[],
  dateRange?: { start?: string; end?: string },
): Promise<ReconciliationResult> {
  // Build query to fetch relevant transactions from DB
  let query = `
    SELECT 
      id, 
      reference_number, 
      provider_reference,
      amount::text as amount, 
      status, 
      phone_number, 
      provider, 
      created_at::text as created_at
    FROM transactions
    WHERE 1=1
  `;
  const params: string[] = [];

  if (dateRange?.start) {
    params.push(dateRange.start);
    query += ` AND created_at >= $${params.length}`;
  }

  if (dateRange?.end) {
    params.push(dateRange.end);
    query += ` AND created_at <= $${params.length}`;
  }

  query += ` ORDER BY created_at DESC`;

  const dbResult = await queryRead(query, params);
  const dbRecords = dbResult.rows;

  // Create lookup maps – index by internal reference_number and provider_reference (#643)
  const dbByReference = new Map<string, any>();
  for (const r of dbRecords) {
    const ref = normalizeReferenceNumber(r.reference_number);
    if (ref) dbByReference.set(ref, r);
    const provRef = normalizeReferenceNumber(r.provider_reference);
    if (provRef) dbByReference.set(provRef, r);
  }

  const providerByReference = new Map(
    providerRows.map((r) => [
      normalizeReferenceNumber(
        r.provider_reference || r.reference_number || r.reference_id,
      ),
      r,
    ]),
  );

  const matched: ReconciliationMatch[] = [];
  const discrepancies: ReconciliationMatch[] = [];
  const matchedDbRefs = new Set<string>();
  const matchedProviderRefs = new Set<string>();

  // Match by reference number or provider reference
  for (const [refNum, providerRow] of providerByReference.entries()) {
    if (!refNum) continue;

    const dbRecord = dbByReference.get(refNum);

    if (dbRecord) {
      if (dbRecord.reference_number) {
        matchedDbRefs.add(normalizeReferenceNumber(dbRecord.reference_number)!);
      }
      if (dbRecord.provider_reference) {
        matchedDbRefs.add(normalizeReferenceNumber(dbRecord.provider_reference)!);
      }
      matchedProviderRefs.add(refNum);

      const dbAmount = normalizeAmount(dbRecord.amount);
      const providerAmount = normalizeAmount(providerRow.amount);

      const amountMatch = dbAmount === providerAmount;
      const statusMatch =
        dbRecord.status.toLowerCase() ===
        (providerRow.status || "").toLowerCase();

      const reconciliationMatch: ReconciliationMatch = {
        reference_number: dbRecord.reference_number,
        amount: dbRecord.amount,
        status: dbRecord.status,
        provider_status: providerRow.status,
        matched: amountMatch && statusMatch,
        db_record: dbRecord,
        provider_record: providerRow,
      };

      if (amountMatch && statusMatch) {
        reconciliationMatch.matched = true;
        matched.push(reconciliationMatch);
      } else {
        reconciliationMatch.matched = false;
        reconciliationMatch.discrepancy_type = !amountMatch 
          ? DiscrepancyType.AmountMismatch 
          : DiscrepancyType.StatusMismatch;
        discrepancies.push(reconciliationMatch);
      }
    }
  }

  // Find orphaned provider records (in CSV but not in DB)
  const orphaned_provider = providerRows.filter((row) => {
    const refNum = normalizeReferenceNumber(
      row.provider_reference || row.reference_number || row.reference_id,
    );
    return refNum && !matchedProviderRefs.has(refNum);
  });

  // Find orphaned DB records (in DB but not in CSV)
  const orphaned_db = dbRecords.filter((record) => {
    const refNum = normalizeReferenceNumber(record.reference_number);
    const provRef = normalizeReferenceNumber(record.provider_reference);
    const isMatched =
      (refNum && matchedDbRefs.has(refNum)) ||
      (provRef && matchedDbRefs.has(provRef));
    return !isMatched;
  });

  const totalMatched = matched.length;
  const totalDiscrepancies = discrepancies.length;
  const totalOrphanedProvider = orphaned_provider.length;
  const totalOrphanedDb = orphaned_db.length;
  const matchRate =
    providerRows.length > 0
      ? ((totalMatched / providerRows.length) * 100).toFixed(2)
      : "0.00";

  return {
    total_provider_rows: providerRows.length,
    total_db_records: dbRecords.length,
    matched,
    discrepancies,
    orphaned_provider,
    orphaned_db,
    summary: {
      match_rate: `${matchRate}%`,
      total_matched: totalMatched,
      total_discrepancies: totalDiscrepancies,
      total_orphaned_provider: totalOrphanedProvider,
      total_orphaned_db: totalOrphanedDb,
    },
  };
}
