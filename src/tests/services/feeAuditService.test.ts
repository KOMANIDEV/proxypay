import { FeeAuditService, LogFeeAuditInput } from "../../services/feeAuditService";
import { pool } from "../../config/database";

jest.mock("../../config/database");

const mockPool = pool as jest.Mocked<typeof pool>;

describe("FeeAuditService", () => {
  let service: FeeAuditService;

  const baseInput: LogFeeAuditInput = {
    transactionId: "txn-uuid-001",
    userId: "user-uuid-001",
    provider: "mtn",
    inputAmount: 10000,
    calculatedFee: 150,
    totalAmount: 10150,
    strategyId: "strategy-uuid-001",
    strategyName: "Standard 1.5%",
    strategyType: "percentage",
    strategyScope: "global",
    feePercentage: 1.5,
    flatAmount: null,
    feeMinimum: 50,
    feeMaximum: 5000,
    timeOverrideActive: false,
    rawFee: 150,
    clampedFee: 150,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FeeAuditService();
  });

  describe("logFeeCalculation", () => {
    it("inserts a fee audit record with all fields", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await service.logFeeCalculation(baseInput);

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [queryText, queryParams] = mockPool.query.mock.calls[0];
      expect(queryText).toMatch(/INSERT INTO fee_audit_log/i);
      expect(queryParams).toContain("txn-uuid-001");
      expect(queryParams).toContain("user-uuid-001");
      expect(queryParams).toContain("mtn");
      expect(queryParams).toContain(10000);
      expect(queryParams).toContain(150);
      expect(queryParams).toContain(10150);
      expect(queryParams).toContain("strategy-uuid-001");
      expect(queryParams).toContain("Standard 1.5%");
      expect(queryParams).toContain("percentage");
      expect(queryParams).toContain("global");
      expect(queryParams).toContain(1.5);
      expect(queryParams).toContain(false);
    });

    it("uses null for optional fields when not provided", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const minimalInput: LogFeeAuditInput = {
        inputAmount: 5000,
        calculatedFee: 0,
        totalAmount: 5000,
        strategyId: "",
        strategyName: "none",
        strategyType: "flat",
        strategyScope: "global",
        timeOverrideActive: false,
        rawFee: 0,
        clampedFee: 0,
      };

      await service.logFeeCalculation(minimalInput);

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const queryParams = mockPool.query.mock.calls[0][1] as unknown[];
      // transactionId, userId, provider should be null
      expect(queryParams[0]).toBeNull();
      expect(queryParams[1]).toBeNull();
      expect(queryParams[2]).toBeNull();
    });

    it("does not throw when the database query fails", async () => {
      mockPool.query.mockRejectedValueOnce(new Error("DB connection error"));

      // Should not throw — non-fatal
      await expect(service.logFeeCalculation(baseInput)).resolves.toBeUndefined();
    });
  });

  describe("getAuditRecords", () => {
    const mockRows = [
      {
        id: "audit-uuid-001",
        transactionId: "txn-uuid-001",
        userId: "user-uuid-001",
        provider: "mtn",
        inputAmount: "10000.00000000",
        calculatedFee: "150.00000000",
        totalAmount: "10150.00000000",
        strategyId: "strategy-uuid-001",
        strategyName: "Standard 1.5%",
        strategyType: "percentage",
        strategyScope: "global",
        feePercentage: "1.5000",
        flatAmount: null,
        feeMinimum: "50.00000000",
        feeMaximum: "5000.00000000",
        timeOverrideActive: false,
        rawFee: "150.00000000",
        clampedFee: "150.00000000",
        createdAt: new Date("2026-09-24T12:00:00Z"),
      },
    ];

    it("returns records and total with no filters", async () => {
      // First call: COUNT query
      mockPool.query.mockResolvedValueOnce({ rows: [{ total: "1" }] } as any);
      // Second call: data query
      mockPool.query.mockResolvedValueOnce({ rows: mockRows } as any);

      const result = await service.getAuditRecords({});

      expect(result.total).toBe(1);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].id).toBe("audit-uuid-001");
      expect(result.records[0].inputAmount).toBe(10000);
      expect(result.records[0].calculatedFee).toBe(150);
      expect(result.records[0].totalAmount).toBe(10150);
      expect(result.records[0].feePercentage).toBe(1.5);
      expect(result.records[0].flatAmount).toBeNull();
    });

    it("applies transactionId filter in the WHERE clause", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ total: "1" }] } as any);
      mockPool.query.mockResolvedValueOnce({ rows: mockRows } as any);

      await service.getAuditRecords({ transactionId: "txn-uuid-001" });

      const countQuery = mockPool.query.mock.calls[0][0] as string;
      const countParams = mockPool.query.mock.calls[0][1] as unknown[];
      expect(countQuery).toMatch(/transaction_id = \$1/i);
      expect(countParams).toContain("txn-uuid-001");
    });

    it("applies userId and provider filters together", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ total: "0" }] } as any);
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.getAuditRecords({ userId: "user-uuid-001", provider: "airtel" });

      const countQuery = mockPool.query.mock.calls[0][0] as string;
      expect(countQuery).toMatch(/user_id = \$1/i);
      expect(countQuery).toMatch(/provider = \$2/i);
    });

    it("applies date range filters", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ total: "0" }] } as any);
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      const from = new Date("2026-09-01T00:00:00Z");
      const to = new Date("2026-09-30T23:59:59Z");

      await service.getAuditRecords({ from, to });

      const countQuery = mockPool.query.mock.calls[0][0] as string;
      const countParams = mockPool.query.mock.calls[0][1] as unknown[];
      expect(countQuery).toMatch(/created_at >= \$1/i);
      expect(countQuery).toMatch(/created_at <= \$2/i);
      expect(countParams).toContain(from);
      expect(countParams).toContain(to);
    });

    it("uses default limit and offset when not provided", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ total: "0" }] } as any);
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.getAuditRecords({});

      const dataParams = mockPool.query.mock.calls[1][1] as unknown[];
      // Last two params are limit=50 and offset=0
      expect(dataParams[dataParams.length - 2]).toBe(50);
      expect(dataParams[dataParams.length - 1]).toBe(0);
    });

    it("respects custom limit and offset", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ total: "100" }] } as any);
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      await service.getAuditRecords({ limit: 10, offset: 20 });

      const dataParams = mockPool.query.mock.calls[1][1] as unknown[];
      expect(dataParams[dataParams.length - 2]).toBe(10);
      expect(dataParams[dataParams.length - 1]).toBe(20);
    });

    it("returns empty records array when no rows found", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ total: "0" }] } as any);
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);

      const result = await service.getAuditRecords({ userId: "nonexistent" });

      expect(result.total).toBe(0);
      expect(result.records).toEqual([]);
    });
  });
});
