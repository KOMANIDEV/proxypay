import { analyzeGasOptimizations } from "../../src/services/sorobanGasAnalyzer";
import { pool } from "../../src/config/database";

jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

const mockPool = pool as jest.Mocked<typeof pool>;

describe("SorobanGasAnalyzer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("analyzeGasOptimizations", () => {
    it("flags high gas operations with high priority", async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            operation: "escrow",
            contract_id: "C1...",
            method: "create_escrow",
            iterations: "50",
            total_gas: "750000000",
            avg_gas: "15000000",
            min_gas: "12000000",
            max_gas: "18000000",
            p50_gas: "14500000",
            p95_gas: "17000000",
            p99_gas: "17800000",
            timestamp: new Date().toISOString(),
          },
        ],
      } as any);

      const opts = await analyzeGasOptimizations();
      expect(opts.length).toBeGreaterThan(0);
      expect(opts[0].priority).toBe("high");
      expect(opts[0].savings_percent).toBe(30);
    });

    it("flags moderate gas operations with medium priority", async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            operation: "htlc",
            contract_id: "C2...",
            method: "claim",
            iterations: "30",
            total_gas: "180000000",
            avg_gas: "6000000",
            min_gas: "5000000",
            max_gas: "7000000",
            p50_gas: "5800000",
            p95_gas: "6800000",
            p99_gas: "6900000",
            timestamp: new Date().toISOString(),
          },
        ],
      } as any);

      const opts = await analyzeGasOptimizations();
      expect(opts.length).toBeGreaterThan(0);
      expect(opts[0].priority).toBe("medium");
    });

    it("returns empty for low gas operations", async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            operation: "simple",
            contract_id: "C3...",
            method: "read",
            iterations: "100",
            total_gas: "200000000",
            avg_gas: "2000000",
            min_gas: "1500000",
            max_gas: "2500000",
            p50_gas: "1900000",
            p95_gas: "2400000",
            p99_gas: "2480000",
            timestamp: new Date().toISOString(),
          },
        ],
      } as any);

      const opts = await analyzeGasOptimizations();
      expect(opts).toHaveLength(0);
    });

    it("flags high gas variance operations", async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            operation: "complex",
            contract_id: "C4...",
            method: "batch_transfer",
            iterations: "20",
            total_gas: "60000000",
            avg_gas: "3000000",
            min_gas: "1000000",
            max_gas: "9000000",
            p50_gas: "2000000",
            p95_gas: "3000000",
            p99_gas: "9100000",
            timestamp: new Date().toISOString(),
          },
        ],
      } as any);

      const opts = await analyzeGasOptimizations();
      // Should flag variance issue (p99 > 3x avg)
      expect(opts.some((o) => o.operation.includes("latency"))).toBe(true);
    });
  });
});
