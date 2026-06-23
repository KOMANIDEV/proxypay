// Mock DB and RabbitMQ before importing the module under test
jest.mock("../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../../src/queue/rabbitmq", () => ({
  rabbitMQManager: { publish: jest.fn() },
  EXCHANGES: { TRANSACTIONS: "transactions.topic" },
  ROUTING_KEYS: { TRANSACTION_PROCESS: "transaction.process" },
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { queryRead, queryWrite } from "../../src/config/database";
import { rabbitMQManager } from "../../src/queue/rabbitmq";
import {
  capturePersistentFailure,
  queryDLQ,
  replayDLQEntry,
  CaptureOptions,
} from "../../src/queue/dlq";

const mockQueryRead = queryRead as jest.Mock;
const mockQueryWrite = queryWrite as jest.Mock;
const mockPublish = rabbitMQManager.publish as jest.Mock;

const sampleEntry = {
  id: "dlq-entry-1",
  original_job_id: "txn-123",
  queue_name: "transaction-processing-queue",
  job_name: "process-transaction",
  job_data: { transactionId: "txn-123", type: "deposit" },
  failure_reason: "Provider timeout",
  attempts_made: 3,
  replayed_at: null,
  replayed_by: null,
  created_at: new Date().toISOString(),
};

describe("DLQ Service", () => {
  beforeEach(() => jest.clearAllMocks());

  // ─── capturePersistentFailure ───────────────────────────────────────────────

  describe("capturePersistentFailure", () => {
    const opts: CaptureOptions = {
      originalJobId: "txn-123",
      queueName: "transaction-processing-queue",
      jobName: "process-transaction",
      jobData: { transactionId: "txn-123" },
      failureReason: "Provider timeout",
      attemptsMade: 3,
    };

    it("inserts a row into dead_letter_queue", async () => {
      mockQueryWrite.mockResolvedValue({ rowCount: 1 });

      await capturePersistentFailure(opts);

      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO dead_letter_queue"),
        [
          "txn-123",
          "transaction-processing-queue",
          "process-transaction",
          JSON.stringify({ transactionId: "txn-123" }),
          "Provider timeout",
          3,
        ],
      );
    });

    it("handles missing originalJobId (nullable)", async () => {
      mockQueryWrite.mockResolvedValue({ rowCount: 1 });

      await capturePersistentFailure({ ...opts, originalJobId: undefined });

      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.any(String),
        [null, opts.queueName, opts.jobName, expect.any(String), opts.failureReason, opts.attemptsMade],
      );
    });

    it("does not throw when DB insert fails (logs error instead)", async () => {
      mockQueryWrite.mockRejectedValue(new Error("DB down"));

      // Should not throw
      await expect(capturePersistentFailure(opts)).resolves.toBeUndefined();
    });
  });

  // ─── queryDLQ ──────────────────────────────────────────────────────────────

  describe("queryDLQ", () => {
    it("returns items and total with no filters", async () => {
      mockQueryRead
        .mockResolvedValueOnce({ rows: [{ count: "2" }] })
        .mockResolvedValueOnce({ rows: [sampleEntry, { ...sampleEntry, id: "dlq-entry-2" }] });

      const result = await queryDLQ();

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it("applies queueName filter", async () => {
      mockQueryRead
        .mockResolvedValueOnce({ rows: [{ count: "1" }] })
        .mockResolvedValueOnce({ rows: [sampleEntry] });

      await queryDLQ({ queueName: "transaction-processing-queue" });

      const countCall = mockQueryRead.mock.calls[0];
      expect(countCall[0]).toContain("queue_name = $1");
      expect(countCall[1]).toContain("transaction-processing-queue");
    });

    it("applies failureReason ILIKE filter", async () => {
      mockQueryRead
        .mockResolvedValueOnce({ rows: [{ count: "1" }] })
        .mockResolvedValueOnce({ rows: [sampleEntry] });

      await queryDLQ({ failureReason: "timeout" });

      const countCall = mockQueryRead.mock.calls[0];
      expect(countCall[0]).toContain("failure_reason ILIKE");
      expect(countCall[1]).toContain("%timeout%");
    });

    it("applies date range filters", async () => {
      mockQueryRead
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [] });

      await queryDLQ({ from: "2026-01-01", to: "2026-12-31" });

      const countCall = mockQueryRead.mock.calls[0];
      expect(countCall[0]).toContain("created_at >=");
      expect(countCall[0]).toContain("created_at <=");
    });

    it("defaults limit to 50 and offset to 0", async () => {
      mockQueryRead
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [] });

      await queryDLQ();

      const dataCall = mockQueryRead.mock.calls[1];
      // Last two params are limit and offset
      const params = dataCall[1] as number[];
      expect(params[params.length - 2]).toBe(50);
      expect(params[params.length - 1]).toBe(0);
    });
  });

  // ─── replayDLQEntry ────────────────────────────────────────────────────────

  describe("replayDLQEntry", () => {
    it("re-publishes job to RabbitMQ and marks replayed_at", async () => {
      mockQueryRead.mockResolvedValue({ rows: [sampleEntry] });
      mockQueryWrite.mockResolvedValue({ rowCount: 1 });
      mockPublish.mockResolvedValue(undefined);

      const result = await replayDLQEntry("dlq-entry-1", "admin-user-1");

      expect(mockPublish).toHaveBeenCalledWith(
        "transactions.topic",
        "transaction.process",
        sampleEntry.job_data,
      );
      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining("replayed_at"),
        ["admin-user-1", "dlq-entry-1"],
      );
      expect(result.replayed_by).toBe("admin-user-1");
      expect(result.replayed_at).toBeTruthy();
    });

    it("throws 404 when entry is not found", async () => {
      mockQueryRead.mockResolvedValue({ rows: [] });

      await expect(replayDLQEntry("nonexistent", "admin-1")).rejects.toMatchObject({
        message: "DLQ entry not found",
        status: 404,
      });
    });

    it("throws 409 when entry has already been replayed", async () => {
      mockQueryRead.mockResolvedValue({
        rows: [{ ...sampleEntry, replayed_at: new Date().toISOString() }],
      });

      await expect(replayDLQEntry("dlq-entry-1", "admin-1")).rejects.toMatchObject({
        message: "DLQ entry has already been replayed",
        status: 409,
      });
    });

    it("propagates RabbitMQ publish errors", async () => {
      mockQueryRead.mockResolvedValue({ rows: [sampleEntry] });
      mockPublish.mockRejectedValue(new Error("RabbitMQ unavailable"));

      await expect(replayDLQEntry("dlq-entry-1", "admin-1")).rejects.toThrow(
        "RabbitMQ unavailable",
      );
      // Should not have updated replayed_at since publish failed
      expect(mockQueryWrite).not.toHaveBeenCalled();
    });
  });
});
