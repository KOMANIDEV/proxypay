/**
 * Tests for #414 — Bulk Compliance Screening
 *  - Batch creation and tracking
 *  - Per-item results and aggregate reporting
 *  - Status polling
 *  - Webhook notification (mocked)
 */

import express from "express";
import request from "supertest";

// Mock dependencies before any imports that use them
jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  },
}));

jest.mock("axios", () => ({
  post: jest.fn().mockResolvedValue({ status: 200 }),
}));

jest.mock("../../src/middleware/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../src/middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../src/middleware/errorHandler", () => ({
  createError: (_code: any, msg: string, meta: any) => {
    const e = new Error(msg) as any;
    e.statusCode = _code;
    e.meta = meta;
    return e;
  },
}));

jest.mock("../../src/constants/errorCodes", () => ({
  ERROR_CODES: {
    INVALID_INPUT: 400,
    NOT_FOUND: 404,
    INTERNAL_ERROR: 500,
  },
}));

// Static imports after mocks
import {
  createBulkScreeningBatch,
  getBatch,
  getBatchReport,
  listBatches,
  _clearBatchStore,
  ScreeningSubject,
} from "../../src/services/bulkComplianceService";
import { bulkComplianceRoutes } from "../../src/routes/bulkCompliance";

// ---------------------------------------------------------------------------
// Helper: wait for async batch processing
// ---------------------------------------------------------------------------

async function waitForBatch(
  batchId: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const batch = getBatch(batchId);
    if (batch?.status === "completed" || batch?.status === "failed") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Batch ${batchId} did not complete within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Service unit tests
// ---------------------------------------------------------------------------

describe("#414 Bulk Compliance Screening — Service", () => {
  beforeEach(() => {
    _clearBatchStore();
    jest.clearAllMocks();
  });

  it("creates a batch with pending status and correct item count", async () => {
    const subjects: ScreeningSubject[] = [
      { ref: "s1", name: "Alice Dupont" },
      { ref: "s2", name: "Bob Mutombo" },
    ];

    const batch = await createBulkScreeningBatch({ subjects });

    expect(batch.batchId).toBeTruthy();
    expect(batch.status).toBe("pending");
    expect(batch.totalItems).toBe(2);
    expect(batch.processedItems).toBe(0);
  });

  it("processes all subjects and marks batch as completed", async () => {
    const subjects: ScreeningSubject[] = [
      { ref: "r1", name: "Harmless Name" },
      { ref: "r2", name: "Another Safe Name" },
    ];

    const batch = await createBulkScreeningBatch({ subjects });
    await waitForBatch(batch.batchId);

    const finished = getBatch(batch.batchId)!;
    expect(finished.status).toBe("completed");
    expect(finished.processedItems).toBe(2);
    expect(finished.results).toHaveLength(2);
    expect(finished.completedAt).toBeTruthy();
  });

  it("returns correct item result refs", async () => {
    const subjects: ScreeningSubject[] = [
      { ref: "ref-abc", name: "Jane Test" },
    ];

    const batch = await createBulkScreeningBatch({ subjects });
    await waitForBatch(batch.batchId);

    const finished = getBatch(batch.batchId)!;
    expect(finished.results[0].ref).toBe("ref-abc");
    expect(["clear", "flagged", "error"]).toContain(finished.results[0].result);
  });

  it("getBatchReport returns summary with completion percentage", async () => {
    const subjects: ScreeningSubject[] = [
      { ref: "rpt-1", name: "Test Subject One" },
      { ref: "rpt-2", name: "Test Subject Two" },
    ];

    const batch = await createBulkScreeningBatch({ subjects });
    await waitForBatch(batch.batchId);

    const report = getBatchReport(batch.batchId);
    expect(report).not.toBeNull();
    expect(report!.summary.totalItems).toBe(2);
    expect(report!.summary.completionPct).toBe(100);
  });

  it("fires webhook when webhookUrl is set", async () => {
    const axios = require("axios");
    const subjects: ScreeningSubject[] = [{ ref: "wh-1", name: "Webhook Test" }];
    const webhookUrl = "https://example.com/webhook";

    const batch = await createBulkScreeningBatch({ subjects, webhookUrl });
    await waitForBatch(batch.batchId);

    expect(axios.post).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({
        event: "bulk_screening.completed",
        batchId: batch.batchId,
      }),
      expect.any(Object),
    );
  });

  it("does NOT fire webhook when webhookUrl is not set", async () => {
    const axios = require("axios");
    const subjects: ScreeningSubject[] = [{ ref: "nowh-1", name: "No Webhook Test" }];

    const batch = await createBulkScreeningBatch({ subjects });
    await waitForBatch(batch.batchId);

    expect(axios.post).not.toHaveBeenCalled();
  });

  it("listBatches returns batches most recent first", async () => {
    await createBulkScreeningBatch({
      subjects: [{ ref: "lb-1", name: "First" }],
    });
    await new Promise((r) => setTimeout(r, 10));
    await createBulkScreeningBatch({
      subjects: [{ ref: "lb-2", name: "Second" }],
    });

    const batches = listBatches();
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(
      new Date(batches[0].createdAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(batches[1].createdAt).getTime());
  });

  it("getBatch returns undefined for unknown batchId", () => {
    expect(getBatch("does-not-exist")).toBeUndefined();
  });

  it("getBatchReport returns null for unknown batchId", () => {
    expect(getBatchReport("does-not-exist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

describe("#414 Bulk Compliance Screening — Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    _clearBatchStore();
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use("/api/v1/compliance/bulk-screening", bulkComplianceRoutes);
    app.use(
      (
        err: any,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(err.statusCode ?? 500).json({ error: err.message });
      },
    );
  });

  it("POST / creates a batch and returns 202", async () => {
    const res = await request(app)
      .post("/api/v1/compliance/bulk-screening")
      .send({
        subjects: [
          { ref: "s1", name: "Alice" },
          { ref: "s2", name: "Bob" },
        ],
      });

    expect(res.status).toBe(202);
    expect(res.body.batchId).toBeTruthy();
    expect(res.body.status).toBe("pending");
    expect(res.body.totalItems).toBe(2);
    expect(res.body.statusUrl).toContain(res.body.batchId);
  });

  it("POST / returns 400 for empty subjects array", async () => {
    const res = await request(app)
      .post("/api/v1/compliance/bulk-screening")
      .send({ subjects: [] });

    expect(res.status).toBe(400);
  });

  it("POST / returns 400 for missing name field", async () => {
    const res = await request(app)
      .post("/api/v1/compliance/bulk-screening")
      .send({ subjects: [{ ref: "s1" }] });

    expect(res.status).toBe(400);
  });

  it("GET /:batchId returns batch status", async () => {
    const createRes = await request(app)
      .post("/api/v1/compliance/bulk-screening")
      .send({ subjects: [{ ref: "gs1", name: "Test" }] });

    const batchId = createRes.body.batchId;

    const getRes = await request(app).get(
      `/api/v1/compliance/bulk-screening/${batchId}`,
    );

    expect(getRes.status).toBe(200);
    expect(getRes.body.batchId).toBe(batchId);
    expect(getRes.body.totalItems).toBe(1);
  });

  it("GET /:batchId returns 404 for unknown batch", async () => {
    const res = await request(app).get(
      "/api/v1/compliance/bulk-screening/nonexistent-batch-id",
    );
    expect(res.status).toBe(404);
  });

  it("GET / lists all batches", async () => {
    await request(app)
      .post("/api/v1/compliance/bulk-screening")
      .send({ subjects: [{ ref: "l1", name: "List Test" }] });

    const listRes = await request(app).get(
      "/api/v1/compliance/bulk-screening",
    );

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.batches)).toBe(true);
    expect(listRes.body.batches.length).toBeGreaterThan(0);
  });

  it("GET /:batchId/report returns report after completion", async () => {
    const createRes = await request(app)
      .post("/api/v1/compliance/bulk-screening")
      .send({
        subjects: [
          { ref: "rp1", name: "Report Subject One" },
          { ref: "rp2", name: "Report Subject Two" },
        ],
      });

    const batchId = createRes.body.batchId;
    await waitForBatch(batchId);

    const reportRes = await request(app).get(
      `/api/v1/compliance/bulk-screening/${batchId}/report`,
    );

    expect(reportRes.status).toBe(200);
    expect(reportRes.body.batchId).toBe(batchId);
    expect(reportRes.body.summary.totalItems).toBe(2);
    expect(reportRes.body.summary.completionPct).toBe(100);
  });
});
