/**
 * Unit tests for the Provider API Schema Change Detection service.
 *
 * Coverage:
 *   1. Canonicalisation & hashing – order-independent hashing
 *   2. diffSchemas – added/removed/modified + breaking classification
 *   3. Versioning – MAJOR on breaking, MINOR on additive, same on no change
 *   4. monitorProviderContract – full pipeline with DB mock + alert dispatch
 *   5. sendSchemaChangeAlert – webhook delivery
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  canonicalizeSchema,
  computeSchemaHash,
  diffSchemas,
  monitorProviderContract,
  sendSchemaChangeAlert,
  analyzeSchemaChange,
  recordProviderContractBaseline,
} from "../providerSchemaMonitorService";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

import { pool } from "../../config/database";

const mockQuery = pool.query as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

const V1_SCHEMA = {
  type: "object",
  required: ["amount", "payer"],
  properties: {
    amount: { type: "number" },
    currency: { type: "string", enum: ["EUR", "USD"] },
    payer: {
      type: "object",
      required: ["partyIdType", "partyId"],
      properties: {
        partyIdType: { type: "string", enum: ["MSISDN"] },
        partyId: { type: "string" },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// 1. Canonicalisation & hashing
// ---------------------------------------------------------------------------

describe("canonicalizeSchema / computeSchemaHash", () => {
  it("produces identical hashes for semantically equal schemas in different key order", () => {
    const a = { amount: { type: "number" }, payer: { type: "string" } };
    const b = { payer: { type: "string" }, amount: { type: "number" } };
    expect(canonicalizeSchema(a)).toBe(canonicalizeSchema(b));
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b));
  });

  it("produces different hashes when the contract changes", () => {
    const a = { amount: { type: "number" } };
    const b = { amount: { type: "string" } };
    expect(computeSchemaHash(a)).not.toBe(computeSchemaHash(b));
  });
});

// ---------------------------------------------------------------------------
// 2. Diffing
// ---------------------------------------------------------------------------

describe("diffSchemas", () => {
  it("detects an added optional field as non-breaking", () => {
    const next = {
      ...V1_SCHEMA,
      properties: { ...V1_SCHEMA.properties, note: { type: "string" } },
    };
    const changes = diffSchemas(V1_SCHEMA, next);
    const added = changes.find(
      (c) => c.path === "properties.note" && c.kind === "added",
    );
    expect(added).toBeDefined();
    expect(added!.breaking).toBe(false);
  });

  it("detects an added required field as breaking", () => {
    const next = {
      ...V1_SCHEMA,
      required: [...V1_SCHEMA.required, "recipient"],
      properties: {
        ...V1_SCHEMA.properties,
        recipient: { type: "string" },
      },
    };
    const changes = diffSchemas(V1_SCHEMA, next);
    const added = changes.find((c) => c.path === "properties.recipient");
    expect(added).toBeDefined();
    expect(added!.breaking).toBe(true);
  });

  it("detects removal of a required field as breaking", () => {
    const next = {
      type: "object",
      required: ["amount"],
      properties: { amount: { type: "number" } },
    };
    const changes = diffSchemas(V1_SCHEMA, next);
    const removed = changes.find(
      (c) => c.path === "properties.payer" && c.kind === "removed",
    );
    expect(removed).toBeDefined();
    expect(removed!.breaking).toBe(true);
  });

  it("detects removal of an optional field as non-breaking", () => {
    const next = {
      ...V1_SCHEMA,
      properties: {
        amount: { type: "number" },
        payer: V1_SCHEMA.properties.payer,
      },
    };
    const changes = diffSchemas(V1_SCHEMA, next);
    const removed = changes.find(
      (c) => c.path === "properties.currency" && c.kind === "removed",
    );
    expect(removed).toBeDefined();
    expect(removed!.breaking).toBe(false);
  });

  it("detects a type change as breaking", () => {
    const next = {
      ...V1_SCHEMA,
      properties: { ...V1_SCHEMA.properties, amount: { type: "string" } },
    };
    const changes = diffSchemas(V1_SCHEMA, next);
    const modified = changes.find((c) => c.path === "properties.amount");
    expect(modified).toBeDefined();
    expect(modified!.breaking).toBe(true);
  });

  it("detects enum value removal as breaking", () => {
    const next = {
      ...V1_SCHEMA,
      properties: {
        ...V1_SCHEMA.properties,
        currency: { type: "string", enum: ["EUR"] },
      },
    };
    const changes = diffSchemas(V1_SCHEMA, next);
    const modified = changes.find(
      (c) => c.path === "properties.currency" && c.kind === "modified",
    );
    expect(modified).toBeDefined();
    expect(modified!.breaking).toBe(true);
  });

  it("recurses into nested objects", () => {
    const next = {
      ...V1_SCHEMA,
      properties: {
        ...V1_SCHEMA.properties,
        payer: {
          ...V1_SCHEMA.properties.payer,
          properties: {
            ...V1_SCHEMA.properties.payer.properties,
            partyId: { type: "number" },
          },
        },
      },
    };
    const changes = diffSchemas(V1_SCHEMA, next);
    const nested = changes.find(
      (c) => c.path === "properties.payer.properties.partyId",
    );
    expect(nested).toBeDefined();
    expect(nested!.breaking).toBe(true);
  });

  it("reports no changes for identical schemas", () => {
    expect(
      diffSchemas(V1_SCHEMA, JSON.parse(JSON.stringify(V1_SCHEMA))),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Versioning
// ---------------------------------------------------------------------------

describe("analyzeSchemaChange (versioning)", () => {
  it("bumps MAJOR on a breaking change", () => {
    const next = {
      ...V1_SCHEMA,
      required: ["amount"],
      properties: { amount: { type: "number" } },
    };
    const result = analyzeSchemaChange(V1_SCHEMA, next);
    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe("2.0.0");
    expect(result.breakingChanges.length).toBeGreaterThan(0);
  });

  it("bumps MINOR on an additive change", () => {
    const next = {
      ...V1_SCHEMA,
      properties: { ...V1_SCHEMA.properties, note: { type: "string" } },
    };
    const result = analyzeSchemaChange(V1_SCHEMA, next);
    expect(result.nextVersion).toBe("1.1.0");
    expect(result.breakingChanges).toEqual([]);
  });

  it("keeps the version when nothing changed", () => {
    const result = analyzeSchemaChange(
      V1_SCHEMA,
      JSON.parse(JSON.stringify(V1_SCHEMA)),
    );
    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// 4. Full monitoring pipeline
// ---------------------------------------------------------------------------

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ver-1",
    provider: "mtn",
    endpoint: "collection/requesttopay",
    version: "1.0.0",
    schema_hash: computeSchemaHash(V1_SCHEMA),
    schema: V1_SCHEMA,
    breaking_change_paths: [],
    change_counts: { added: 0, removed: 0, modified: 0, breaking: 0 },
    detected_at: new Date("2026-08-01T00:00:00Z"),
    alerted_at: null,
    created_at: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("monitorProviderContract", () => {
  it("records a baseline version when nothing is tracked yet", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // getLatestSchemaVersion
    mockQuery.mockResolvedValueOnce({ rows: [versionRow()] }); // insert

    const result = await monitorProviderContract(
      "mtn",
      "collection/requesttopay",
      V1_SCHEMA,
      { alertOnChange: false },
    );
    expect(result.changed).toBe(true);
    expect(result.version).toBe("1.0.0");
    expect(result.alerted).toBe(false);
  });

  it("detects a breaking change and bumps to 2.0.0", async () => {
    const next = {
      ...V1_SCHEMA,
      required: ["amount"],
      properties: { amount: { type: "number" } },
    };
    mockQuery.mockResolvedValueOnce({ rows: [versionRow()] }); // latest
    mockQuery.mockResolvedValueOnce({
      rows: [
        versionRow({
          version: "2.0.0",
          schema_hash: computeSchemaHash(next),
          schema: next,
          breaking_change_paths: ["properties.payer"],
        }),
      ],
    }); // insert

    const result = await monitorProviderContract(
      "mtn",
      "collection/requesttopay",
      next,
      { alertOnChange: false },
    );
    expect(result.changed).toBe(true);
    expect(result.version).toBe("2.0.0");
    expect(result.breakingChanges.length).toBeGreaterThan(0);
  });

  it("detects an additive change and bumps to 1.1.0", async () => {
    const next = {
      ...V1_SCHEMA,
      properties: { ...V1_SCHEMA.properties, note: { type: "string" } },
    };
    mockQuery.mockResolvedValueOnce({ rows: [versionRow()] }); // latest
    mockQuery.mockResolvedValueOnce({
      rows: [
        versionRow({
          version: "1.1.0",
          schema_hash: computeSchemaHash(next),
          schema: next,
        }),
      ],
    }); // insert

    const result = await monitorProviderContract(
      "mtn",
      "collection/requesttopay",
      next,
      { alertOnChange: false },
    );
    expect(result.version).toBe("1.1.0");
    expect(result.breakingChanges).toEqual([]);
  });

  it("does not create a new version when the contract is unchanged", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [versionRow()] }); // latest

    const result = await monitorProviderContract(
      "mtn",
      "collection/requesttopay",
      V1_SCHEMA,
    );
    expect(result.changed).toBe(false);
    expect(result.version).toBe("1.0.0");
    // No insert should have happened.
    expect(mockQuery.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Alerting
// ---------------------------------------------------------------------------

describe("sendSchemaChangeAlert", () => {
  it("returns false and does not fetch when no webhook is configured", async () => {
    const spy = jest.spyOn(globalThis, "fetch");
    const result = await sendSchemaChangeAlert({
      provider: "mtn",
      endpoint: "x",
      version: "2.0.0",
      changes: [],
      breakingChanges: [],
      detectedAt: new Date().toISOString(),
    });
    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("delivers the alert payload to the webhook", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await sendSchemaChangeAlert(
      {
        provider: "airtel",
        endpoint: "payments/status",
        version: "3.0.0",
        changes: [{ kind: "removed", path: "x", breaking: true, detail: "d" }],
        breakingChanges: [
          { kind: "removed", path: "x", breaking: true, detail: "d" },
        ],
        detectedAt: "2026-08-25T00:00:00Z",
      },
      "https://alerts.example.com/hook",
    );

    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      "https://alerts.example.com/hook",
      expect.objectContaining({ method: "POST" }),
    );
    spy.mockRestore();
  });
});

describe("recordProviderContractBaseline", () => {
  it("skips insert when the baseline hash already matches", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [versionRow()] }); // latest
    const result = await recordProviderContractBaseline(
      "mtn",
      "collection/requesttopay",
      V1_SCHEMA,
    );
    expect(result.version).toBe("1.0.0");
    expect(mockQuery.mock.calls.length).toBe(1); // no insert
  });
});
