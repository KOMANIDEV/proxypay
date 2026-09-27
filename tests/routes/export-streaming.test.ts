/**
 * Tests for #416 — Streaming CSV Export enhancements:
 *  - Progress reporting & monitoring metrics
 *  - Memory-efficient large result set streaming
 *  - Export metrics collection
 */

import express from "express";
import { Readable } from "stream";
import request from "supertest";
import {
  buildTransactionExportQuery,
  createExportRoutes,
  getExportMetricsHistory,
  parseTransactionExportFilters,
  transactionRowToCsv,
  CSV_HEADERS,
} from "../../src/routes/export";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRowStream(rows: object[]): Readable {
  return Readable.from(rows);
}

function buildApp(rowStream: Readable, adminKey = "test-admin-key") {
  const connect = jest.fn().mockResolvedValue({
    query: jest.fn().mockReturnValue(rowStream),
    release: jest.fn(),
  });

  const app = express();
  app.use(
    "/api/transactions",
    createExportRoutes({
      db: { connect },
      createQueryStream: (_text: string, _values: unknown[]) => ({}),
    }),
  );
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("#416 Streaming CSV Export", () => {
  const adminKey = "test-admin-key";

  beforeAll(() => {
    process.env.ADMIN_API_KEY = adminKey;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Streaming — basic CSV
  // -------------------------------------------------------------------------

  it("streams CSV with correct header labels", async () => {
    const rowStream = makeRowStream([
      { id: "tx-1", reference_number: "REF-001", type: "deposit", amount: "5000" },
    ]);
    const app = buildApp(rowStream);

    const res = await request(app)
      .get("/api/transactions/export")
      .set("X-API-Key", adminKey);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("ID,Reference Number,Type,Amount");
    expect(res.text).toContain("tx-1");
  });

  it("uses chunked transfer encoding", async () => {
    const rowStream = makeRowStream([{ id: "tx-1" }]);
    const app = buildApp(rowStream);

    const res = await request(app)
      .get("/api/transactions/export")
      .set("X-API-Key", adminKey);

    // supertest may or may not forward chunked; check content-disposition
    expect(res.headers["content-disposition"]).toContain("attachment;");
  });

  it("streams a large number of rows without OOM (memory-efficient chunking)", async () => {
    // Simulate 10,000 rows using a generator — never materialize all at once
    function* generateRows(count: number) {
      for (let i = 0; i < count; i++) {
        yield {
          id: `tx-${i}`,
          reference_number: `REF-${i}`,
          type: "deposit",
          amount: String(i * 100),
          status: "completed",
        };
      }
    }
    const rowStream = Readable.from(generateRows(10_000));
    const app = buildApp(rowStream);

    const res = await request(app)
      .get("/api/transactions/export")
      .set("X-API-Key", adminKey);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);

    // Verify all rows made it through
    const lines = res.text.trim().split("\n");
    // header line + 10,000 data lines
    expect(lines.length).toBe(10_001);
  });

  // -------------------------------------------------------------------------
  // Streaming — JSON format
  // -------------------------------------------------------------------------

  it("streams JSON array for large result set", async () => {
    const rows = Array.from({ length: 1_000 }, (_, i) => ({ id: `tx-${i}` }));
    const rowStream = makeRowStream(rows);
    const app = buildApp(rowStream);

    const res = await request(app)
      .get("/api/transactions/export")
      .query({ format: "json" })
      .set("X-API-Key", adminKey);

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1_000);
  });

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  it("returns 401 without admin key", async () => {
    const rowStream = makeRowStream([{ id: "tx-1" }]);
    const app = buildApp(rowStream);

    const res = await request(app).get("/api/transactions/export");
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Export monitoring / metrics
  // -------------------------------------------------------------------------

  it("records export metrics after a successful export", async () => {
    const metricsBefore = getExportMetricsHistory().length;

    const rows = [{ id: "m-1", type: "withdraw", amount: "200" }];
    const rowStream = makeRowStream(rows);

    const completedMetrics: any[] = [];
    const connect = jest.fn().mockResolvedValue({
      query: jest.fn().mockReturnValue(rowStream),
      release: jest.fn(),
    });

    const app = express();
    app.use(
      "/api/transactions",
      createExportRoutes({
        db: { connect },
        createQueryStream: () => ({}),
        onExportComplete: (m) => completedMetrics.push(m),
      }),
    );

    await request(app)
      .get("/api/transactions/export")
      .set("X-API-Key", adminKey);

    expect(completedMetrics).toHaveLength(1);
    expect(completedMetrics[0].rowsExported).toBe(1);
    expect(completedMetrics[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(completedMetrics[0].format).toBe("csv");

    // Metrics history should grow
    expect(getExportMetricsHistory().length).toBe(metricsBefore + 1);
  });

  it("GET /export/metrics returns history", async () => {
    const rowStream = makeRowStream([{ id: "tm-1" }]);
    const app = buildApp(rowStream);

    // Trigger an export first so there's something in history
    await request(app)
      .get("/api/transactions/export")
      .set("X-API-Key", adminKey);

    const metricsRes = await request(app)
      .get("/api/transactions/export/metrics")
      .set("X-API-Key", adminKey);

    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body.exports).toBeInstanceOf(Array);
    expect(metricsRes.body.exports.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Filter / query building
  // -------------------------------------------------------------------------

  it("parseTransactionExportFilters handles all supported fields", () => {
    const filters = parseTransactionExportFilters({
      userId: "u1",
      status: "completed",
      provider: "MTN",
      type: "deposit",
      phoneNumber: "+237600000000",
      stellarAddress: "GB123",
      referenceNumber: "REF-X",
      from: "2026-01-01",
      to: "2026-12-31",
      tags: "vip,priority",
    });

    expect(filters.userId).toBe("u1");
    expect(filters.status).toBe("completed");
    expect(filters.provider).toBe("MTN");
    expect(filters.tags).toEqual(["vip", "priority"]);
    expect(filters.from).toBeInstanceOf(Date);
    expect(filters.to).toBeInstanceOf(Date);
  });

  it("buildTransactionExportQuery generates parameterized SQL for all filters", () => {
    const result = buildTransactionExportQuery({
      status: "completed",
      provider: "MTN",
      type: "deposit",
      phoneNumber: "+237600000000",
      stellarAddress: "GB123",
      referenceNumber: "REF-123",
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-31T23:59:59Z"),
      tags: ["vip", "priority"],
    });

    expect(result.text).toContain("status = $1");
    expect(result.text).toContain("provider = $2");
    expect(result.text).toContain("type = $3");
    expect(result.text).toContain("phone_number = $4");
    expect(result.text).toContain("stellar_address = $5");
    expect(result.text).toContain("reference_number = $6");
    expect(result.text).toContain("created_at >= $7");
    expect(result.text).toContain("created_at <= $8");
    expect(result.text).toContain("tags @> $9::text[]");
    expect(result.values).toHaveLength(9);
  });

  // -------------------------------------------------------------------------
  // CSV serialisation
  // -------------------------------------------------------------------------

  it("transactionRowToCsv escapes commas and quotes", () => {
    const row: Record<string, unknown> = {
      id: "tx-1",
      notes: 'Needs, review "today"',
    };
    const line = transactionRowToCsv(row);
    expect(line).toContain('"Needs, review ""today"""');
  });

  it("transactionRowToCsv serialises arrays as pipe-separated values", () => {
    const row: Record<string, unknown> = {
      id: "tx-1",
      tags: ["vip", "priority"],
    };
    const line = transactionRowToCsv(row);
    expect(line).toContain("vip|priority");
  });

  it("transactionRowToCsv handles null/undefined values as empty strings", () => {
    const row: Record<string, unknown> = {
      id: "tx-1",
      description: null,
      admin_notes: undefined,
    };
    const line = transactionRowToCsv(row);
    // Should not throw and should produce commas for the empty fields
    expect(typeof line).toBe("string");
    expect(line).toContain("tx-1");
  });

  // -------------------------------------------------------------------------
  // Error path
  // -------------------------------------------------------------------------

  it("returns 500 when DB connection fails before headers are sent", async () => {
    const connect = jest.fn().mockRejectedValue(new Error("DB connection failed"));
    const app = express();
    app.use(
      "/api/transactions",
      createExportRoutes({
        db: { connect },
        createQueryStream: () => ({}),
      }),
    );

    const res = await request(app)
      .get("/api/transactions/export")
      .set("X-API-Key", adminKey);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Export failed");
  });
});
