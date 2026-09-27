/**
 * Batch webhook event delivery tests (Issue #626).
 *
 * Merchant webhooks must emit `batch_started`, `batch_completed` (with a
 * summary) and `batch_failed` (with error details), and honour the batch event
 * filter configuration.
 */
jest.mock("axios");

jest.mock("../../src/models/batchOperation", () => {
  const operationModel = {
    findById: jest.fn(),
    updateWebhookStatus: jest.fn().mockResolvedValue(undefined),
  };
  const itemModel = {
    getBatchSummary: jest.fn().mockResolvedValue({ pending: 1 }),
    findById: jest.fn(),
  };
  (globalThis as any).__batchModels = { operationModel, itemModel };
  return {
    BatchOperationModel: jest.fn().mockImplementation(() => operationModel),
    BatchItemModel: jest.fn().mockImplementation(() => itemModel),
    BatchOperationStatus: {
      Pending: "pending",
      Processing: "processing",
      Completed: "completed",
      Failed: "failed",
      Partial: "partial",
    },
    BatchItemStatus: {
      Pending: "pending",
      Processing: "processing",
      Completed: "completed",
      Failed: "failed",
      Retrying: "retrying",
    },
    WebhookStatus: { Pending: "pending", Sent: "sent", Failed: "failed" },
  };
});

import axios from "axios";
import {
  BatchWebhookService,
  resolveEnabledBatchEvents,
  BATCH_WEBHOOK_EVENTS,
} from "../../src/services/batchWebhookService";

const { operationModel, itemModel } = (globalThis as any).__batchModels;
const mockedPost = axios.post as jest.Mock;

const WEBHOOK_URL = "https://merchant.example.com/webhooks";

function operationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "batch-1",
    batchReference: "BATCH-MTN-1",
    provider: "mtn",
    operationType: "payout",
    status: "processing",
    totalItems: 10,
    completedItems: 8,
    failedItems: 1,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:05.000Z"),
    webhookUrl: WEBHOOK_URL,
    webhookStatus: "pending",
    ...overrides,
  };
}

describe("BatchWebhookService batch events (#626)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BATCH_WEBHOOK_EVENTS;
    mockedPost.mockResolvedValue({ status: 200 });
    operationModel.findById.mockResolvedValue(operationFixture());
    operationModel.updateWebhookStatus.mockResolvedValue(undefined);
    itemModel.getBatchSummary.mockResolvedValue({ pending: 1 });
  });

  it("delivers batch_started", async () => {
    const service = new BatchWebhookService();

    const result = await service.sendBatchStartedWebhook("batch-1");

    expect(result).toEqual({ success: true });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [, payload] = mockedPost.mock.calls[0];
    expect(payload).toMatchObject({
      event: "batch_started",
      batchId: "batch-1",
      totalItems: 10,
      pendingItems: 1,
    });
    expect(payload.summary).toBeUndefined();
    expect(operationModel.updateWebhookStatus).toHaveBeenCalledWith(
      "batch-1",
      "sent",
    );
  });

  it("delivers batch_completed with a summary", async () => {
    const service = new BatchWebhookService();

    const result = await service.sendBatchCompletedWebhook("batch-1");

    expect(result).toEqual({ success: true });
    const [, payload] = mockedPost.mock.calls[0];
    expect(payload.event).toBe("batch_completed");
    expect(payload.summary).toEqual({
      totalItems: 10,
      completedItems: 8,
      failedItems: 1,
      pendingItems: 1,
      successRate: 0.8,
      durationMs: 5000,
    });
  });

  it("delivers batch_failed with error details", async () => {
    const service = new BatchWebhookService();

    const result = await service.sendBatchFailedWebhook("batch-1", "provider timeout");

    expect(result).toEqual({ success: true });
    const [, payload] = mockedPost.mock.calls[0];
    expect(payload.event).toBe("batch_failed");
    expect(payload.error).toBe("provider timeout");
  });

  it("skips events disabled by the batch event filter", async () => {
    const service = new BatchWebhookService({ enabledEvents: ["batch_completed"] });

    const result = await service.sendBatchStartedWebhook("batch-1");

    expect(result).toEqual({ success: true, skipped: true });
    expect(mockedPost).not.toHaveBeenCalled();
    expect(service.isEventEnabled("batch_started")).toBe(false);
  });

  it("skips delivery when no webhook URL is configured", async () => {
    operationModel.findById.mockResolvedValue(operationFixture({ webhookUrl: null }));
    const service = new BatchWebhookService();

    const result = await service.sendBatchStartedWebhook("batch-1");

    expect(result).toEqual({ success: true, skipped: true });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("records the webhook status as failed when delivery exhausts retries", async () => {
    mockedPost.mockRejectedValue(new Error("connection refused"));
    const service = new BatchWebhookService();
    // Avoid real backoff sleeps between retries
    (service as any).retryDelayMs = 0;

    const result = await service.sendBatchFailedWebhook("batch-1", "boom");

    expect(result.success).toBe(false);
    expect(operationModel.updateWebhookStatus).toHaveBeenCalledWith(
      "batch-1",
      "failed",
      expect.stringContaining("connection refused"),
    );
  });

  it("enables every batch event by default and honours the env allow-list", () => {
    expect(resolveEnabledBatchEvents(undefined)).toEqual(BATCH_WEBHOOK_EVENTS);
    expect(resolveEnabledBatchEvents("")).toEqual(BATCH_WEBHOOK_EVENTS);
    expect(resolveEnabledBatchEvents("batch_failed,batch_started")).toEqual([
      "batch_failed",
      "batch_started",
    ]);
    expect(resolveEnabledBatchEvents("unknown,event")).toEqual([]);
  });
});
