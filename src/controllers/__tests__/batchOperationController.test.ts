import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import {
  listBatchOperations,
  getBatchOperation,
  listBatchItems,
  getBatchItem,
  getBatchOperationByReference,
  retryBatchOperation,
  retryBatchItem,
  getBatchOperationSummary,
} from "../batchOperationController";
import { queryWrite } from "../../config/database";
import {
  BatchOperationModel,
  BatchItemModel,
  BatchOperationStatus,
  BatchItemStatus,
} from "../../models/batchOperation";

const batchOperationModel = new BatchOperationModel();
const batchItemModel = new BatchItemModel();

// Create test app
const app = express();
app.use(express.json());
app.get("/api/batch-operations", listBatchOperations);
app.get("/api/batch-operations/:id", getBatchOperation);
app.get("/api/batch-operations/reference/:batchReference", getBatchOperationByReference);
app.get("/api/batch-operations/:id/items", listBatchItems);
app.get("/api/batch-operations/:id/items/:itemId", getBatchItem);
app.post("/api/batch-operations/:id/retry", retryBatchOperation);
app.post("/api/batch-items/:id/retry", retryBatchItem);
app.get("/api/batch-operations/:id/summary", getBatchOperationSummary);

describe("Batch Operation Controller", () => {
  let testBatchId: string;
  let testItemId: string;

  beforeAll(async () => {
    // Clean up test data
    await queryWrite("DELETE FROM batch_items WHERE batch_id IN (SELECT id FROM batch_operations WHERE provider = 'test-controller')");
    await queryWrite("DELETE FROM batch_operations WHERE provider = 'test-controller'");
  });

  afterAll(async () => {
    // Clean up test data
    await queryWrite("DELETE FROM batch_items WHERE batch_id IN (SELECT id FROM batch_operations WHERE provider = 'test-controller')");
    await queryWrite("DELETE FROM batch_operations WHERE provider = 'test-controller'");
  });

  beforeEach(async () => {
    // Create a test batch operation
    const operation = await batchOperationModel.create({
      batchReference: "TEST-CTRL-001",
      provider: "test-controller",
      operationType: "payout",
      totalItems: 3,
    });
    testBatchId = operation.id;

    // Create test items
    const item1 = await batchItemModel.create({
      batchId: testBatchId,
      referenceId: "REF-001",
      phoneNumber: "+237670000001",
      amount: "100.00",
    });
    testItemId = item1.id;

    await batchItemModel.create({
      batchId: testBatchId,
      referenceId: "REF-002",
      phoneNumber: "+237670000002",
      amount: "200.00",
    });

    await batchItemModel.create({
      batchId: testBatchId,
      referenceId: "REF-003",
      phoneNumber: "+237670000003",
      amount: "300.00",
    });
  });

  describe("GET /api/batch-operations", () => {
    it("should list batch operations", async () => {
      const response = await request(app)
        .get("/api/batch-operations")
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body).toHaveProperty("pagination");
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.pagination).toHaveProperty("limit");
      expect(response.body.pagination).toHaveProperty("offset");
      expect(response.body.pagination).toHaveProperty("total");
    });

    it("should filter by provider", async () => {
      const response = await request(app)
        .get("/api/batch-operations?provider=test-controller")
        .expect(200);

      expect(response.body.data).toBeDefined();
      response.body.data.forEach((op: any) => {
        expect(op.provider).toBe("test-controller");
      });
    });

    it("should filter by status", async () => {
      await batchOperationModel.updateStatus(testBatchId, BatchOperationStatus.Processing);

      const response = await request(app)
        .get("/api/batch-operations?status=processing")
        .expect(200);

      expect(response.body.data).toBeDefined();
      response.body.data.forEach((op: any) => {
        expect(op.status).toBe(BatchOperationStatus.Processing);
      });
    });

    it("should handle invalid query parameters", async () => {
      const response = await request(app)
        .get("/api/batch-operations?status=invalid")
        .expect(400);

      expect(response.body).toHaveProperty("error");
      expect(response.body).toHaveProperty("details");
    });

    it("should paginate results", async () => {
      const response = await request(app)
        .get("/api/batch-operations?limit=1&offset=0")
        .expect(200);

      expect(response.body.data.length).toBeLessThanOrEqual(1);
      expect(response.body.pagination.limit).toBe(1);
      expect(response.body.pagination.offset).toBe(0);
    });
  });

  describe("GET /api/batch-operations/:id", () => {
    it("should get batch operation by ID", async () => {
      const response = await request(app)
        .get(`/api/batch-operations/${testBatchId}`)
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body.data.id).toBe(testBatchId);
      expect(response.body.data).toHaveProperty("summary");
    });

    it("should return 404 for non-existent ID", async () => {
      const response = await request(app)
        .get("/api/batch-operations/00000000-0000-0000-0000-000000000000")
        .expect(404);

      expect(response.body).toHaveProperty("error");
    });
  });

  describe("GET /api/batch-operations/reference/:batchReference", () => {
    it("should get batch operation by reference", async () => {
      const response = await request(app)
        .get("/api/batch-operations/reference/TEST-CTRL-001")
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body.data.batchReference).toBe("TEST-CTRL-001");
    });

    it("should return 404 for non-existent reference", async () => {
      const response = await request(app)
        .get("/api/batch-operations/reference/NON-EXISTENT")
        .expect(404);

      expect(response.body).toHaveProperty("error");
    });
  });

  describe("GET /api/batch-operations/:id/items", () => {
    it("should list items in a batch operation", async () => {
      const response = await request(app)
        .get(`/api/batch-operations/${testBatchId}/items`)
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body).toHaveProperty("pagination");
      expect(Array.isArray(response.body.data)).toBe(true);
      response.body.data.forEach((item: any) => {
        expect(item.batchId).toBe(testBatchId);
      });
    });

    it("should filter items by status", async () => {
      await batchItemModel.updateStatus(testItemId, BatchItemStatus.Completed);

      const response = await request(app)
        .get(`/api/batch-operations/${testBatchId}/items?status=completed`)
        .expect(200);

      expect(response.body.data).toBeDefined();
      response.body.data.forEach((item: any) => {
        expect(item.status).toBe(BatchItemStatus.Completed);
      });
    });

    it("should handle invalid query parameters", async () => {
      const response = await request(app)
        .get(`/api/batch-operations/${testBatchId}/items?status=invalid`)
        .expect(400);

      expect(response.body).toHaveProperty("error");
    });
  });

  describe("GET /api/batch-operations/:id/items/:itemId", () => {
    it("should get specific batch item", async () => {
      const response = await request(app)
        .get(`/api/batch-operations/${testBatchId}/items/${testItemId}`)
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body.data.id).toBe(testItemId);
    });

    it("should return 404 for non-existent item", async () => {
      const response = await request(app)
        .get(`/api/batch-operations/${testBatchId}/items/00000000-0000-0000-0000-000000000000`)
        .expect(404);

      expect(response.body).toHaveProperty("error");
    });
  });

  describe("GET /api/batch-operations/:id/summary", () => {
    it("should get batch operation summary", async () => {
      const response = await request(app)
        .get(`/api/batch-operations/${testBatchId}/summary`)
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body.data).toHaveProperty("operation");
      expect(response.body.data).toHaveProperty("summary");
      expect(response.body.data).toHaveProperty("itemsByStatus");
      expect(response.body.data.summary).toHaveProperty("total");
      expect(response.body.data.summary).toHaveProperty("completed");
      expect(response.body.data.summary).toHaveProperty("failed");
      expect(response.body.data.summary).toHaveProperty("pending");
    });
  });

  describe("POST /api/batch-operations/:id/retry", () => {
    it("should retry failed items in a batch operation", async () => {
      // Set batch to failed status
      await batchOperationModel.updateStatus(testBatchId, BatchOperationStatus.Failed);
      
      // Mark some items as failed
      const items = await batchItemModel.findByBatchId(testBatchId);
      for (const item of items) {
        await batchItemModel.updateStatus(item.id, BatchItemStatus.Failed, "Test error");
      }

      const response = await request(app)
        .post(`/api/batch-operations/${testBatchId}/retry`)
        .expect(200);

      expect(response.body).toHaveProperty("message");
      expect(response.body).toHaveProperty("data");
      expect(response.body.data).toHaveProperty("batchId");
      expect(response.body.data).toHaveProperty("retriedCount");
      expect(response.body.data).toHaveProperty("items");
    });

    it("should return 400 for non-failed batch", async () => {
      await batchOperationModel.updateStatus(testBatchId, BatchOperationStatus.Completed);

      const response = await request(app)
        .post(`/api/batch-operations/${testBatchId}/retry`)
        .expect(400);

      expect(response.body).toHaveProperty("error");
    });

    it("should return 404 for non-existent batch", async () => {
      const response = await request(app)
        .post("/api/batch-operations/00000000-0000-0000-0000-000000000000/retry")
        .expect(404);

      expect(response.body).toHaveProperty("error");
    });
  });

  describe("POST /api/batch-items/:id/retry", () => {
    it("should retry a single failed batch item", async () => {
      // Mark item as failed
      await batchItemModel.updateStatus(testItemId, BatchItemStatus.Failed, "Test error");

      const response = await request(app)
        .post(`/api/batch-items/${testItemId}/retry`)
        .expect(200);

      expect(response.body).toHaveProperty("message");
      expect(response.body).toHaveProperty("data");
      expect(response.body.data.retryCount).toBeGreaterThan(0);
    });

    it("should return 400 for non-failed item", async () => {
      await batchItemModel.updateStatus(testItemId, BatchItemStatus.Completed);

      const response = await request(app)
        .post(`/api/batch-items/${testItemId}/retry`)
        .expect(400);

      expect(response.body).toHaveProperty("error");
    });

    it("should return 400 when max retries exceeded", async () => {
      // Set max retries to 0
      await batchItemModel.updateStatus(testItemId, BatchItemStatus.Failed, "Test error");
      await queryWrite(
        "UPDATE batch_items SET max_retries = 0, retry_count = 0 WHERE id = $1",
        [testItemId]
      );

      const response = await request(app)
        .post(`/api/batch-items/${testItemId}/retry`)
        .expect(400);

      expect(response.body).toHaveProperty("error");
      expect(response.body.data).toHaveProperty("retryCount");
      expect(response.body.data).toHaveProperty("maxRetries");
    });

    it("should return 404 for non-existent item", async () => {
      const response = await request(app)
        .post("/api/batch-items/00000000-0000-0000-0000-000000000000/retry")
        .expect(404);

      expect(response.body).toHaveProperty("error");
    });
  });
});
