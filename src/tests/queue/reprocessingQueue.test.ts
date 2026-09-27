import { reprocessingService } from "../services/reprocessingService";
import { queryRead, queryWrite } from "../../config/database";

jest.mock("../../config/database");
jest.mock("../services/retry");
jest.mock("../services/mobilemoney/mobileMoneyService");
jest.mock("../queue/rabbitmq");

describe("ReprocessingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getPolicy", () => {
    it("should return default policy for known provider", async () => {
      const policy = await reprocessingService.getPolicy("mtn");
      expect(policy.provider).toBe("mtn");
      expect(policy.maxAttempts).toBe(5);
      expect(policy.baseDelayMs).toBe(5000);
    });

    it("should return default policy for unknown provider", async () => {
      const policy = await reprocessingService.getPolicy("unknown");
      expect(policy.provider).toBe("unknown");
      expect(policy.maxAttempts).toBe(5);
    });
  });

  describe("enqueueFailedTransaction", () => {
    it("should enqueue a transaction for reprocessing", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });
      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "repro-1",
            transaction_id: "txn-1",
            provider: "mtn",
            attempt_number: 0,
            max_attempts: 5,
            status: "pending",
          },
        ],
      });

      const result = await reprocessingService.enqueueFailedTransaction("txn-1", "mtn");
      expect(result.transactionId).toBe("txn-1");
      expect(result.status).toBe("pending");
    });

    it("should throw if transaction is already in reprocessing queue", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [{ id: "repro-existing", transaction_id: "txn-1", status: "pending" }],
      });

      await expect(reprocessingService.enqueueFailedTransaction("txn-1", "mtn")).rejects.toThrow(
        "already in reprocessing queue",
      );
    });
  });

  describe("processJob", () => {
    it("should return failure if transaction not found", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      const job = {
        id: "repro-1",
        transactionId: "txn-missing",
        provider: "mtn",
        attemptNumber: 0,
        maxAttempts: 5,
        status: "pending" as const,
      };

      const result = await reprocessingService.processJob(job);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Transaction not found");
    });
  });

  describe("getJobStats", () => {
    it("should return stats grouped by status", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          { status: "pending", count: "3" },
          { status: "completed", count: "10" },
          { status: "failed", count: "2" },
        ],
      });

      const stats = await reprocessingService.getJobStats();
      expect(stats.pending).toBe(3);
      expect(stats.completed).toBe(10);
      expect(stats.failed).toBe(2);
    });
  });

  describe("updatePolicy", () => {
    it("should update provider policy", async () => {
      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [{ provider: "mtn", max_attempts: 10, base_delay_ms: 1000, backoff_strategy: "exponential" }],
      });

      const policy = await reprocessingService.updatePolicy("mtn", { maxAttempts: 10 });
      expect(policy.maxAttempts).toBe(10);
    });
  });
});
