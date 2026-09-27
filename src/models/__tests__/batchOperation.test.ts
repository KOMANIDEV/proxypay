import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { queryWrite, queryRead } from "../../config/database";
import {
  BatchOperationModel,
  BatchItemModel,
  BatchOperationStatus,
  BatchItemStatus,
  WebhookStatus,
} from "../batchOperation";

const batchOperationModel = new BatchOperationModel();
const batchItemModel = new BatchItemModel();

describe("BatchOperationModel", () => {
  let testBatchId: string;

  beforeAll(async () => {
    // Clean up any existing test data
    await queryWrite("DELETE FROM batch_items WHERE batch_id IN (SELECT id FROM batch_operations WHERE provider = 'test-provider')");
    await queryWrite("DELETE FROM batch_operations WHERE provider = 'test-provider'");
  });

  afterAll(async () => {
    // Clean up test data
    await queryWrite("DELETE FROM batch_items WHERE batch_id IN (SELECT id FROM batch_operations WHERE provider = 'test-provider')");
    await queryWrite("DELETE FROM batch_operations WHERE provider = 'test-provider'");
  });

  describe("create", () => {
    it("should create a new batch operation", async () => {
      const operation = await batchOperationModel.create({
        batchReference: "TEST-BATCH-001",
        provider: "test-provider",
        operationType: "payout",
        totalItems: 10,
        webhookUrl: "https://example.com/webhook",
      });

      expect(operation).toBeDefined();
      expect(operation.batchReference).toBe("TEST-BATCH-001");
      expect(operation.provider).toBe("test-provider");
      expect(operation.status).toBe(BatchOperationStatus.Pending);
      expect(operation.totalItems).toBe(10);
      expect(operation.webhookUrl).toBe("https://example.com/webhook");
      expect(operation.completedItems).toBe(0);
      expect(operation.failedItems).toBe(0);

      testBatchId = operation.id;
    });

    it("should generate batch reference if not provided", async () => {
      const operation = await batchOperationModel.create({
        provider: "test-provider",
        operationType: "payout",
      });

      expect(operation.batchReference).toBeDefined();
      expect(operation.batchReference).toMatch(/^BATCH-TEST-PROVIDER-\d+-[A-Z0-9]{8}$/);

      await queryWrite("DELETE FROM batch_operations WHERE id = $1", [operation.id]);
    });
  });

  describe("findById", () => {
    it("should find batch operation by ID", async () => {
      const operation = await batchOperationModel.findById(testBatchId);

      expect(operation).toBeDefined();
      expect(operation?.id).toBe(testBatchId);
      expect(operation?.batchReference).toBe("TEST-BATCH-001");
    });

    it("should return null for non-existent ID", async () => {
      const operation = await batchOperationModel.findById("00000000-0000-0000-0000-000000000000");
      expect(operation).toBeNull();
    });
  });

  describe("findByBatchReference", () => {
    it("should find batch operation by reference", async () => {
      const operation = await batchOperationModel.findByBatchReference("TEST-BATCH-001");

      expect(operation).toBeDefined();
      expect(operation?.batchReference).toBe("TEST-BATCH-001");
      expect(operation?.id).toBe(testBatchId);
    });

    it("should return null for non-existent reference", async () => {
      const operation = await batchOperationModel.findByBatchReference("NON-EXISTENT");
      expect(operation).toBeNull();
    });
  });

  describe("updateStatus", () => {
    it("should update batch operation status", async () => {
      const updated = await batchOperationModel.updateStatus(testBatchId, BatchOperationStatus.Processing);

      expect(updated).toBeDefined();
      expect(updated?.status).toBe(BatchOperationStatus.Processing);
      expect(updated?.id).toBe(testBatchId);
    });
  });

  describe("updateWebhookStatus", () => {
    it("should update webhook status", async () => {
      const updated = await batchOperationModel.updateWebhookStatus(
        testBatchId,
        WebhookStatus.Sent,
      );

      expect(updated).toBeDefined();
      expect(updated?.webhookStatus).toBe(WebhookStatus.Sent);
      expect(updated?.id).toBe(testBatchId);
    });

    it("should update webhook status with error", async () => {
      const updated = await batchOperationModel.updateWebhookStatus(
        testBatchId,
        WebhookStatus.Failed,
        "Connection timeout",
      );

      expect(updated).toBeDefined();
      expect(updated?.webhookStatus).toBe(WebhookStatus.Failed);
      expect(updated?.webhookLastError).toBe("Connection timeout");
    });
  });

  describe("list", () => {
    it("should list batch operations with filters", async () => {
      const operations = await batchOperationModel.list(10, 0, {
        provider: "test-provider",
        status: BatchOperationStatus.Processing,
      });

      expect(Array.isArray(operations)).toBe(true);
      expect(operations.length).toBeGreaterThan(0);
      expect(operations[0].provider).toBe("test-provider");
      expect(operations[0].status).toBe(BatchOperationStatus.Processing);
    });

    it("should paginate results", async () => {
      const page1 = await batchOperationModel.list(1, 0, { provider: "test-provider" });
      const page2 = await batchOperationModel.list(1, 1, { provider: "test-provider" });

      expect(page1.length).toBe(1);
      expect(page2.length).toBeLessThanOrEqual(1);
      if (page2.length > 0) {
        expect(page1[0].id).not.toBe(page2[0].id);
      }
    });
  });

  describe("count", () => {
    it("should count batch operations with filters", async () => {
      const count = await batchOperationModel.count({
        provider: "test-provider",
        status: BatchOperationStatus.Processing,
      });

      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThan(0);
    });
  });
});

describe("BatchItemModel", () => {
  let testBatchId: string;
  let testItemId: string;

  beforeAll(async () => {
    // Create a test batch operation
    const operation = await batchOperationModel.create({
      batchReference: "TEST-BATCH-ITEMS-001",
      provider: "test-provider",
      operationType: "payout",
      totalItems: 5,
    });
    testBatchId = operation.id;
  });

  afterAll(async () => {
    // Clean up
    await queryWrite("DELETE FROM batch_items WHERE batch_id = $1", [testBatchId]);
    await queryWrite("DELETE FROM batch_operations WHERE id = $1", [testBatchId]);
  });

  describe("create", () => {
    it("should create a new batch item", async () => {
      const item = await batchItemModel.create({
        batchId: testBatchId,
        transactionId: "test-transaction-001",
        referenceId: "REF-001",
        phoneNumber: "+237670000001",
        amount: "100.00",
        maxRetries: 3,
      });

      expect(item).toBeDefined();
      expect(item.batchId).toBe(testBatchId);
      expect(item.referenceId).toBe("REF-001");
      expect(item.status).toBe(BatchItemStatus.Pending);
      expect(item.retryCount).toBe(0);
      expect(item.maxRetries).toBe(3);

      testItemId = item.id;
    });

    it("should enforce unique constraint on batchId and referenceId", async () => {
      await expect(
        batchItemModel.create({
          batchId: testBatchId,
          referenceId: "REF-001",
        }),
      ).rejects.toThrow();
    });
  });

  describe("findById", () => {
    it("should find batch item by ID", async () => {
      const item = await batchItemModel.findById(testItemId);

      expect(item).toBeDefined();
      expect(item?.id).toBe(testItemId);
      expect(item?.referenceId).toBe("REF-001");
    });

    it("should return null for non-existent ID", async () => {
      const item = await batchItemModel.findById("00000000-0000-0000-0000-000000000000");
      expect(item).toBeNull();
    });
  });

  describe("findByBatchId", () => {
    it("should find items by batch ID", async () => {
      const items = await batchItemModel.findByBatchId(testBatchId);

      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].batchId).toBe(testBatchId);
    });
  });

  describe("findByReferenceId", () => {
    it("should find item by batch ID and reference ID", async () => {
      const item = await batchItemModel.findByReferenceId(testBatchId, "REF-001");

      expect(item).toBeDefined();
      expect(item?.referenceId).toBe("REF-001");
      expect(item?.batchId).toBe(testBatchId);
    });

    it("should return null for non-existent reference", async () => {
      const item = await batchItemModel.findByReferenceId(testBatchId, "NON-EXISTENT");
      expect(item).toBeNull();
    });
  });

  describe("updateStatus", () => {
    it("should update item status", async () => {
      const updated = await batchItemModel.updateStatus(
        testItemId,
        BatchItemStatus.Completed,
        undefined,
        "PROV-REF-001",
      );

      expect(updated).toBeDefined();
      expect(updated?.status).toBe(BatchItemStatus.Completed);
      expect(updated?.providerReference).toBe("PROV-REF-001");
      expect(updated?.processedAt).toBeDefined();
    });

    it("should update item status with error message", async () => {
      // Create another test item
      const item = await batchItemModel.create({
        batchId: testBatchId,
        referenceId: "REF-002",
      });

      const updated = await batchItemModel.updateStatus(
        item.id,
        BatchItemStatus.Failed,
        "Insufficient funds",
      );

      expect(updated).toBeDefined();
      expect(updated?.status).toBe(BatchItemStatus.Failed);
      expect(updated?.errorMessage).toBe("Insufficient funds");
    });
  });

  describe("incrementRetryCount", () => {
    it("should increment retry count and set status to retrying", async () => {
      // Create a failed item
      const item = await batchItemModel.create({
        batchId: testBatchId,
        referenceId: "REF-003",
      });

      await batchItemModel.updateStatus(item.id, BatchItemStatus.Failed, "Test error");

      const updated = await batchItemModel.incrementRetryCount(item.id);

      expect(updated).toBeDefined();
      expect(updated?.retryCount).toBe(1);
      expect(updated?.status).toBe(BatchItemStatus.Retrying);
    });
  });

  describe("getFailedItemsForRetry", () => {
    it("should get failed items that can be retried", async () => {
      // Create items with different retry counts
      await batchItemModel.create({
        batchId: testBatchId,
        referenceId: "REF-004",
      });
      
      const item5 = await batchItemModel.create({
        batchId: testBatchId,
        referenceId: "REF-005",
        maxRetries: 2,
      });

      await batchItemModel.updateStatus(item5.id, BatchItemStatus.Failed, "Error");
      await batchItemModel.incrementRetryCount(item5.id); // retryCount = 1
      await batchItemModel.updateStatus(item5.id, BatchItemStatus.Failed, "Error again"); // retryCount = 1, status = failed

      const failedItems = await batchItemModel.getFailedItemsForRetry(testBatchId);

      expect(Array.isArray(failedItems)).toBe(true);
      expect(failedItems.length).toBeGreaterThan(0);
      failedItems.forEach(item => {
        expect(item.status).toBe(BatchItemStatus.Failed);
        expect(item.retryCount).toBeLessThan(item.maxRetries);
      });
    });
  });

  describe("getBatchSummary", () => {
    it("should return batch summary", async () => {
      const summary = await batchItemModel.getBatchSummary(testBatchId);

      expect(summary).toBeDefined();
      expect(typeof summary.total).toBe("number");
      expect(typeof summary.completed).toBe("number");
      expect(typeof summary.failed).toBe("number");
      expect(typeof summary.pending).toBe("number");
      expect(typeof summary.retrying).toBe("number");
      expect(summary.total).toBeGreaterThan(0);
    });
  });

  describe("list", () => {
    it("should list items with filters", async () => {
      const items = await batchItemModel.list(10, 0, {
        batchId: testBatchId,
        status: BatchItemStatus.Completed,
      });

      expect(Array.isArray(items)).toBe(true);
      items.forEach(item => {
        expect(item.batchId).toBe(testBatchId);
        expect(item.status).toBe(BatchItemStatus.Completed);
      });
    });
  });

  describe("count", () => {
    it("should count items with filters", async () => {
      const count = await batchItemModel.count({
        batchId: testBatchId,
        status: BatchItemStatus.Completed,
      });

      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
