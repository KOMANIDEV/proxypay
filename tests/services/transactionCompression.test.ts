import {
  computeDelta,
  filterDeltaForSubscription,
  processTransactionUpdate,
  getBandwidthMetrics,
  resetBandwidthMetrics,
  type FieldSubscription,
} from "../../src/services/transactionCompression";

beforeEach(() => {
  resetBandwidthMetrics();
});

describe("computeDelta", () => {
  it("returns full snapshot when previous is null", () => {
    const current = { id: "1", status: "pending", amount: 100 };
    const delta = computeDelta(null, current);
    expect(delta).not.toBeNull();
    expect(delta!.changedFields).toEqual(current);
    expect(delta!.removedFields).toEqual([]);
  });

  it("detects changed fields", () => {
    const prev = { id: "1", status: "pending", amount: 100 };
    const curr = { id: "1", status: "completed", amount: 100 };
    const delta = computeDelta(prev, curr);
    expect(delta).not.toBeNull();
    expect(delta!.changedFields).toEqual({ status: "completed" });
    expect(delta!.removedFields).toEqual([]);
  });

  it("detects removed fields", () => {
    const prev = { id: "1", status: "pending", extra: "x" };
    const curr = { id: "1", status: "pending" };
    const delta = computeDelta(prev, curr);
    expect(delta).not.toBeNull();
    expect(delta!.removedFields).toEqual(["extra"]);
  });

  it("returns null when no changes", () => {
    const snap = { id: "1", status: "pending" };
    expect(computeDelta(snap, { ...snap })).toBeNull();
  });

  it("detects added fields", () => {
    const prev = { id: "1" };
    const curr = { id: "1", newField: true };
    const delta = computeDelta(prev, curr);
    expect(delta!.changedFields).toEqual({ newField: true });
  });
});

describe("filterDeltaForSubscription", () => {
  it("returns full delta when subscription is null", () => {
    const delta = {
      id: "1",
      changedFields: { status: "completed", amount: 50 },
      removedFields: [],
      timestamp: new Date().toISOString(),
    };
    expect(filterDeltaForSubscription(delta, null)).toEqual(delta);
  });

  it("filters to subscribed fields only", () => {
    const delta = {
      id: "1",
      changedFields: { status: "completed", amount: 50, internal: "secret" },
      removedFields: [],
      timestamp: new Date().toISOString(),
    };
    const sub: FieldSubscription = { fields: new Set(["status"]) };
    const filtered = filterDeltaForSubscription(delta, sub);
    expect(filtered.changedFields).toEqual({ status: "completed" });
  });

  it("respects alwaysInclude fields", () => {
    const delta = {
      id: "1",
      changedFields: { status: "completed", internal: "secret" },
      removedFields: [],
      timestamp: new Date().toISOString(),
    };
    const sub: FieldSubscription = { fields: new Set(["status"]) };
    const filtered = filterDeltaForSubscription(delta, sub, ["internal"]);
    expect(filtered.changedFields).toEqual({ status: "completed", internal: "secret" });
  });
});

describe("processTransactionUpdate", () => {
  it("returns full payload on first update", () => {
    const tx = { id: "1", status: "pending", amount: 100 };
    const result = processTransactionUpdate(null, tx);
    expect(result).not.toBeNull();
    expect(result!.fullSizeBytes).toBeGreaterThan(0);
  });

  it("returns delta on subsequent updates", () => {
    const prev = { id: "1", status: "pending", amount: 100 };
    const curr = { id: "1", status: "completed", amount: 100 };
    const result = processTransactionUpdate(prev, curr);
    expect(result).not.toBeNull();
    // Delta may be larger for small objects due to wrapper fields; verify it's a valid delta
    expect(result!.payload.changedFields).toEqual({ status: "completed" });
    expect(result!.bytesSaved).toBeGreaterThanOrEqual(0);
  });

  it("returns null when no changes", () => {
    const snap = { id: "1", status: "pending" };
    expect(processTransactionUpdate(snap, { ...snap })).toBeNull();
  });

  it("tracks bandwidth metrics", () => {
    const tx = { id: "1", status: "pending" };
    processTransactionUpdate(null, tx);
    processTransactionUpdate(tx, { id: "1", status: "completed" });

    const m = getBandwidthMetrics();
    expect(m.fullPayloadsSent).toBe(1);
    expect(m.deltaPayloadsSent).toBe(1);
    expect(m.totalBytesSent).toBeGreaterThan(0);
  });
});
