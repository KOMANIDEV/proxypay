import {
  validateCSVSchema,
  previewCSVImport,
  rollbackCSVImport,
  parseCSV,
  reconcileTransactions,
} from "../csvReconciliation";
import { queryRead, queryWrite } from "../../config/database";

jest.mock("../../config/database");

describe("CSV Validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("validateCSVSchema", () => {
    it("should validate correct CSV data", () => {
      const rows = [
        { reference_number: "TXN-001", amount: "100.50", status: "completed", phone_number: "+1234567890", provider: "mtn" },
        { reference_number: "TXN-002", amount: "200.00", status: "pending", phone_number: "+0987654321", provider: "airtel" },
      ];

      const result = validateCSVSchema(rows);
      expect(result.isValid).toBe(true);
      expect(result.summary.validRows).toBe(2);
      expect(result.summary.errorRows).toBe(0);
    });

    it("should detect missing required fields", () => {
      const rows = [
        { reference_number: "TXN-001", amount: "100.50", status: "completed", phone_number: "+1234567890" },
      ];

      const result = validateCSVSchema(rows);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.field === "provider")).toBe(true);
    });

    it("should detect invalid amount format", () => {
      const rows = [
        { reference_number: "TXN-001", amount: "not-a-number", status: "completed", phone_number: "+1234567890", provider: "mtn" },
      ];

      const result = validateCSVSchema(rows);
      expect(result.errors.some((e) => e.field === "amount")).toBe(true);
    });

    it("should warn on non-standard status", () => {
      const rows = [
        { reference_number: "TXN-001", amount: "100.50", status: "unknown_status", phone_number: "+1234567890", provider: "mtn" },
      ];

      const result = validateCSVSchema(rows);
      expect(result.warnings.some((w) => w.field === "status")).toBe(true);
    });

    it("should handle empty rows array", () => {
      const result = validateCSVSchema([]);
      expect(result.isValid).toBe(true);
      expect(result.summary.totalRows).toBe(0);
    });
  });

  describe("previewCSVImport", () => {
    it("should return preview with validation", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      const csvContent = `reference_number,amount,status,phone_number,provider\nTXN-001,100.50,completed,+1234567890,mtn`;
      const buffer = Buffer.from(csvContent);

      const preview = await previewCSVImport(buffer);
      expect(preview.validation.isValid).toBe(true);
      expect(preview.estimatedChanges.matched).toBe(0);
    });

    it("should skip reconciliation when validation fails", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      const csvContent = `reference_number,amount,status,phone_number\nTXN-001,100.50,completed,+1234567890`;
      const buffer = Buffer.from(csvContent);

      const preview = await previewCSVImport(buffer);
      expect(preview.validation.isValid).toBe(false);
      expect(preview.preview.matched).toHaveLength(0);
    });
  });

  describe("rollbackCSVImport", () => {
    it("should rollback an import", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [{ id: "import-1", backup_snapshot: [{ id: "1", reference_number: "TXN-001" }] }],
      });
      (queryWrite as jest.Mock).mockResolvedValue({});

      const result = await rollbackCSVImport("import-1");
      expect(result.importId).toBe("import-1");
      expect(result.recordsRestored).toBe(1);
    });

    it("should throw for non-existent import", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(rollbackCSVImport("non-existent")).rejects.toThrow("Import not found");
    });

    it("should throw for already rolled back import", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [{ id: "import-1", rolled_back_at: new Date().toISOString() }],
      });

      await expect(rollbackCSVImport("import-1")).rejects.toThrow("already been rolled back");
    });
  });
});
