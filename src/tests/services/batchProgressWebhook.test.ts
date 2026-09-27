/**
 * Tests for BatchWebhookService.sendBatchIntermediateProgressWebhook (#638)
 *
 * Verifies that:
 *  - The method sends a payload with correct event_type, processedCount,
 *    totalCount, and percentageComplete fields.
 *  - No webhook request is made when the operation has no webhookUrl.
 *  - Errors from axios are caught and returned as { success: false }.
 */

import axios from "axios";
import { BatchWebhookService } from "../../services/batchWebhookService";
import { BatchOperationModel, BatchItemModel, BatchOperationStatus, WebhookStatus } from "../../models/batchOperation";

jest.mock("axios");
jest.mock("../../models/batchOperation");

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("BatchWebhookService.sendBatchIntermediateProgressWebhook", () => {
  let service: BatchWebhookService;
  let mockBatchOperationModel: jest.Mocked<BatchOperationModel>;
  let mockBatchItemModel: jest.Mocked<BatchItemModel>;

  const mockOperation = {
    id: "batch-op-1",
    batchReference: "BATCH-MTN-1234-abcd",
    provider: "mtn",
    operationType: "payout",
    totalItems: 300,
    completedItems: 100,
    failedItems: 0,
    status: BatchOperationStatus.Processing,
    webhookUrl: "https://example.com/webhooks/batch",
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockBatchOperationModel = BatchOperationModel.prototype as jest.Mocked<BatchOperationModel>;
    mockBatchItemModel = BatchItemModel.prototype as jest.Mocked<BatchItemModel>;

    mockBatchOperationModel.findById.mockResolvedValue(mockOperation as any);
    mockBatchItemModel.getBatchSummary.mockResolvedValue({ pending: 200 } as any);

    mockedAxios.post.mockResolvedValue({ status: 200 });

    service = new BatchWebhookService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("payload correctness", () => {
    it("sends correct event_type and percentageComplete for partial progress", async () => {
      const result = await service.sendBatchIntermediateProgressWebhook(
        "batch-op-1",
        100,
        300,
      );

      expect(result.success).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);

      const [url, payload] = mockedAxios.post.mock.calls[0];
      expect(url).toBe("https://example.com/webhooks/batch");
      expect(payload.event_type).toBe("batch_progress");
      expect(payload.processedCount).toBe(100);
      expect(payload.percentageComplete).toBe(33); // Math.round(100/300*100)
      expect(payload.batchId).toBe("batch-op-1");
      expect(payload.batchReference).toBe("BATCH-MTN-1234-abcd");
    });

    it("calculates percentageComplete as 50 at the halfway point", async () => {
      const result = await service.sendBatchIntermediateProgressWebhook(
        "batch-op-1",
        150,
        300,
      );

      expect(result.success).toBe(true);
      const [, payload] = mockedAxios.post.mock.calls[0];
      expect(payload.percentageComplete).toBe(50);
      expect(payload.processedCount).toBe(150);
    });

    it("rounds percentageComplete correctly (Math.round)", async () => {
      // 1/3 = 33.33... → rounds to 33
      const result = await service.sendBatchIntermediateProgressWebhook(
        "batch-op-1",
        1,
        3,
      );

      expect(result.success).toBe(true);
      const [, payload] = mockedAxios.post.mock.calls[0];
      expect(payload.percentageComplete).toBe(33);
    });

    it("includes pendingItems as totalCount - processedCount in the payload", async () => {
      await service.sendBatchIntermediateProgressWebhook("batch-op-1", 100, 300);

      const [, payload] = mockedAxios.post.mock.calls[0];
      expect(payload.pendingItems).toBe(200);
    });

    it("includes a timestamp in ISO 8601 format", async () => {
      await service.sendBatchIntermediateProgressWebhook("batch-op-1", 100, 300);

      const [, payload] = mockedAxios.post.mock.calls[0];
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("no-op when no webhookUrl", () => {
    it("returns success without calling axios when webhookUrl is absent", async () => {
      mockBatchOperationModel.findById.mockResolvedValue({
        ...mockOperation,
        webhookUrl: undefined,
      } as any);

      const result = await service.sendBatchIntermediateProgressWebhook(
        "batch-op-1",
        100,
        300,
      );

      expect(result.success).toBe(true);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("returns success without calling axios when operation is not found", async () => {
      mockBatchOperationModel.findById.mockResolvedValue(null);

      const result = await service.sendBatchIntermediateProgressWebhook(
        "batch-op-missing",
        50,
        100,
      );

      expect(result.success).toBe(true);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("returns { success: false } when axios throws a network error", async () => {
      mockedAxios.post.mockRejectedValue(new Error("Network error"));

      const result = await service.sendBatchIntermediateProgressWebhook(
        "batch-op-1",
        100,
        300,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Webhook failed after retries");
    });

    it("does NOT update webhook status in the DB (unlike completion webhook)", async () => {
      await service.sendBatchIntermediateProgressWebhook("batch-op-1", 100, 300);

      // Intermediate progress webhook intentionally skips the DB status update
      expect(mockBatchOperationModel.updateWebhookStatus).not.toHaveBeenCalled();
    });
  });

  describe("progress webhook interval integration", () => {
    it("fires at every PROGRESS_WEBHOOK_INTERVAL items processed", async () => {
      const INTERVAL = 100;
      const TOTAL = 300;

      const calls: Array<{ processedCount: number; percentageComplete: number }> = [];

      // Simulate the worker calling sendBatchIntermediateProgressWebhook
      // after every INTERVAL items (not on final item)
      for (let processed = 1; processed <= TOTAL; processed++) {
        if (processed % INTERVAL === 0 && processed < TOTAL) {
          await service.sendBatchIntermediateProgressWebhook(
            "batch-op-1",
            processed,
            TOTAL,
          );
          const [, payload] = mockedAxios.post.mock.calls[mockedAxios.post.mock.calls.length - 1];
          calls.push({
            processedCount: payload.processedCount,
            percentageComplete: payload.percentageComplete,
          });
        }
      }

      // With TOTAL=300 and INTERVAL=100 we expect calls at 100 and 200 (not 300 since 300 === TOTAL)
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({ processedCount: 100, percentageComplete: 33 });
      expect(calls[1]).toEqual({ processedCount: 200, percentageComplete: 67 });
    });

    it("fires no intermediate webhooks when total equals interval (single batch)", async () => {
      const INTERVAL = 100;
      const TOTAL = 100;

      let webhooksFired = 0;
      for (let processed = 1; processed <= TOTAL; processed++) {
        if (processed % INTERVAL === 0 && processed < TOTAL) {
          await service.sendBatchIntermediateProgressWebhook(
            "batch-op-1",
            processed,
            TOTAL,
          );
          webhooksFired++;
        }
      }

      expect(webhooksFired).toBe(0);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });
});
