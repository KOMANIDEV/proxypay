import {
  createFeeBumpAttempt,
  getFeeBumpAttempt,
  getFeeBumpRecoveryStats,
} from "../../src/services/feeBumpRecoveryService";
import { pool } from "../../src/config/database";

// Mock database
jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

const mockPool = pool as jest.Mocked<typeof pool>;

describe("FeeBumpRecoveryService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createFeeBumpAttempt", () => {
    it("creates a fee bump attempt with correct defaults", async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      const attempt = await createFeeBumpAttempt({
        transactionId: "tx_123",
        originalHash: "abc123",
        feeAmount: 100000,
      });

      expect(attempt.transaction_id).toBe("tx_123");
      expect(attempt.original_hash).toBe("abc123");
      expect(attempt.status).toBe("pending");
      expect(attempt.attempt_number).toBe(0);
      expect(attempt.fee_amount).toBe(100000);
      expect(attempt.max_retries).toBe(5);
    });

    it("respects custom max_retries", async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      const attempt = await createFeeBumpAttempt({
        transactionId: "tx_456",
        originalHash: "def456",
        feeAmount: 200000,
        maxRetries: 3,
      });

      expect(attempt.max_retries).toBe(3);
    });
  });

  describe("getFeeBumpAttempt", () => {
    it("returns null for non-existent attempt", async () => {
      mockPool.query.mockResolvedValue({ rows: [] } as any);

      const result = await getFeeBumpAttempt("nonexistent");
      expect(result).toBeNull();
    });

    it("returns attempt data when found", async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            id: "fb_test",
            transaction_id: "tx_123",
            original_hash: "abc",
            fee_bump_hash: "fb_abc",
            status: "submitted",
            attempt_number: 1,
            max_retries: 5,
            fee_amount: "100000",
            failure_reason: null,
            error_message: null,
            next_retry_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      } as any);

      const result = await getFeeBumpAttempt("fb_test");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("submitted");
      expect(result!.fee_amount).toBe(100000);
    });
  });

  describe("getFeeBumpRecoveryStats", () => {
    it("returns correct stats", async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            total: 10,
            pending: 2,
            confirmed: 5,
            failed: 2,
            dead_letter: 1,
          },
        ],
      } as any);

      const stats = await getFeeBumpRecoveryStats();
      expect(stats.total).toBe(10);
      expect(stats.confirmed).toBe(5);
      expect(stats.success_rate).toBe(50);
    });

    it("handles zero total gracefully", async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ total: 0, pending: 0, confirmed: 0, failed: 0, dead_letter: 0 }],
      } as any);

      const stats = await getFeeBumpRecoveryStats();
      expect(stats.success_rate).toBe(0);
    });
  });
});
