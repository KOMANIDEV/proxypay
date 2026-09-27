import {
  TransactionCompressionService,
  FieldSubscription,
  applyDelta,
  validateDelta,
  TransactionSnapshot,
  TransactionDelta,
} from "../../src/websocket/transactionCompression";

describe("TransactionCompressionService (#373)", () => {
  let service: TransactionCompressionService;

  beforeEach(() => {
    service = new TransactionCompressionService();
  });

  afterEach(() => {
    service.reset();
  });

  // ---------------------------------------------------------------------------
  // Delta computation
  // ---------------------------------------------------------------------------

  describe("computeDelta", () => {
    it("returns full delta on first computation", () => {
      const delta = service.computeDelta("tx-1", {
        id: "tx-1",
        status: "pending",
        amount: "100",
        provider: "mtn",
      });

      expect(delta).not.toBeNull();
      expect(delta!.id).toBe("tx-1");
      expect(delta!.sequenceNumber).toBe(1);
      expect(delta!.changedFields).toEqual({
        status: "pending",
        amount: "100",
        provider: "mtn",
      });
      expect(delta!.removedFields).toEqual([]);
    });

    it("returns only changed fields on subsequent computations", () => {
      service.computeDelta("tx-1", {
        id: "tx-1",
        status: "pending",
        amount: "100",
      });

      const delta = service.computeDelta("tx-1", {
        id: "tx-1",
        status: "completed",
        amount: "100",
      });

      expect(delta).not.toBeNull();
      expect(delta!.changedFields).toEqual({ status: "completed" });
      expect(delta!.removedFields).toEqual([]);
      expect(delta!.sequenceNumber).toBe(2);
    });

    it("returns null when nothing changed", () => {
      service.computeDelta("tx-1", {
        id: "tx-1",
        status: "pending",
        amount: "100",
      });

      const delta = service.computeDelta("tx-1", {
        id: "tx-1",
        status: "pending",
        amount: "100",
      });

      expect(delta).toBeNull();
    });

    it("detects removed fields", () => {
      service.computeDelta("tx-1", {
        id: "tx-1",
        status: "pending",
        amount: "100",
        provider: "mtn",
      });

      const delta = service.computeDelta("tx-1", {
        id: "tx-1",
        status: "completed",
        amount: "100",
      });

      expect(delta).not.toBeNull();
      expect(delta!.removedFields).toEqual(["provider"]);
    });

    it("increments sequence numbers per transaction", () => {
      service.computeDelta("tx-1", { id: "tx-1", status: "a" });
      service.computeDelta("tx-1", { id: "tx-1", status: "b" });
      const delta = service.computeDelta("tx-1", { id: "tx-1", status: "c" });

      expect(delta!.sequenceNumber).toBe(3);
    });

    it("tracks sequence counters independently per transaction", () => {
      const d1 = service.computeDelta("tx-1", { id: "tx-1", status: "a" });
      const d2 = service.computeDelta("tx-2", { id: "tx-2", status: "a" });

      expect(d1!.sequenceNumber).toBe(1);
      expect(d2!.sequenceNumber).toBe(1);
    });

    it("ignores the id field in delta", () => {
      service.computeDelta("tx-1", { id: "tx-1", status: "a" });
      const delta = service.computeDelta("tx-1", { id: "tx-1", status: "b" });

      expect(delta!.changedFields).not.toHaveProperty("id");
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot management
  // ---------------------------------------------------------------------------

  describe("snapshot management", () => {
    it("stores and retrieves snapshots", () => {
      service.setSnapshot("tx-1", { status: "pending", amount: "50" });
      const snap = service.getSnapshot("tx-1");
      expect(snap).toEqual({ status: "pending", amount: "50" });
    });

    it("returns null for unknown transaction", () => {
      expect(service.getSnapshot("nonexistent")).toBeNull();
    });

    it("clears snapshots", () => {
      service.setSnapshot("tx-1", { status: "a" });
      service.clearSnapshot("tx-1");
      expect(service.getSnapshot("tx-1")).toBeNull();
    });

    it("updates snapshot on computeDelta", () => {
      service.computeDelta("tx-1", { id: "tx-1", status: "a" });
      service.computeDelta("tx-1", { id: "tx-1", status: "b" });
      expect(service.getSnapshot("tx-1")).toEqual({ id: "tx-1", status: "b" });
    });
  });

  // ---------------------------------------------------------------------------
  // Field subscriptions
  // ---------------------------------------------------------------------------

  describe("field subscriptions", () => {
    it("returns full payload when no subscription", () => {
      const payload = { id: "tx-1", status: "completed", amount: "100" };
      const result = service.filterBySubscription(payload);
      expect(result).toEqual(payload);
    });

    it("returns only subscribed fields", () => {
      const payload = {
        id: "tx-1",
        status: "completed",
        amount: "100",
        provider: "mtn",
      };
      const sub: FieldSubscription = {
        clientId: "c1",
        fields: new Set(["status", "amount"]),
      };
      const result = service.filterBySubscription(payload, sub);
      expect(result).toEqual({ status: "completed", amount: "100" });
    });

    it("returns empty object when no fields match", () => {
      const payload = { id: "tx-1", status: "completed" };
      const sub: FieldSubscription = {
        clientId: "c1",
        fields: new Set(["nonexistent"]),
      };
      const result = service.filterBySubscription(payload, sub);
      expect(result).toEqual({});
    });

    it("merges delta with subscription correctly", () => {
      const delta = {
        id: "tx-1",
        changedFields: { status: "completed", amount: "200", provider: "airtel" },
        removedFields: [],
        sequenceNumber: 1,
        timestamp: Date.now(),
      };
      const sub: FieldSubscription = {
        clientId: "c1",
        fields: new Set(["status", "provider"]),
      };

      const result = service.mergeDeltaWithSubscription(delta, sub);
      expect(result).toEqual({ status: "completed", provider: "airtel" });
    });

    it("returns full delta fields when subscription is empty", () => {
      const delta = {
        id: "tx-1",
        changedFields: { status: "completed" },
        removedFields: [],
        sequenceNumber: 1,
        timestamp: Date.now(),
      };

      const result = service.mergeDeltaWithSubscription(delta);
      expect(result).toEqual({ status: "completed" });
    });
  });

  // ---------------------------------------------------------------------------
  // Gzip compression
  // ---------------------------------------------------------------------------

  describe("gzip compression", () => {
    it("does not compress payloads below threshold", async () => {
      const small = JSON.stringify({ status: "ok" });
      const result = await service.maybeCompress(small);

      expect(result.compressed).toBe(false);
      expect(result.algorithm).toBe("none");
      expect(result.data).toBe(small);
    });

    it("compresses large payloads with gzip", async () => {
      const largeObj: Record<string, string> = {};
      for (let i = 0; i < 200; i++) {
        largeObj[`field_${i}`] = `value_${i}_${"x".repeat(20)}`;
      }
      const large = JSON.stringify(largeObj);

      const result = await service.maybeCompress(large);

      expect(result.compressed).toBe(true);
      expect(result.algorithm).toBe("gzip");
      expect(result.compressedSize).toBeLessThan(result.originalSize);
      expect(result.checksum).toBeTruthy();
    });

    it("decompresses gzipped payload back to original", async () => {
      const largeObj: Record<string, string> = {};
      for (let i = 0; i < 200; i++) {
        largeObj[`field_${i}`] = `value_${i}_${"x".repeat(20)}`;
      }
      const original = JSON.stringify(largeObj);

      const compressed = await service.maybeCompress(original);
      expect(compressed.compressed).toBe(true);

      const decompressed = await service.decompress(compressed.data as Buffer);
      expect(decompressed).toBe(original);
    });

    it("does not compress when compressed size >= original", async () => {
      const randomBytes = Buffer.alloc(2000);
      for (let i = 0; i < 2000; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
      const incompressible = randomBytes.toString("binary");
      const result = await service.maybeCompress(incompressible);

      if (result.compressedSize >= result.originalSize) {
        expect(result.compressed).toBe(false);
        expect(result.algorithm).toBe("none");
      }
    });

    it("generates consistent checksums", async () => {
      const payload = JSON.stringify({ data: "test-checksum" });
      const r1 = await service.maybeCompress(payload);
      const r2 = await service.maybeCompress(payload);

      expect(r1.checksum).toBe(r2.checksum);
    });
  });

  // ---------------------------------------------------------------------------
  // Bandwidth metrics
  // ---------------------------------------------------------------------------

  describe("bandwidth metrics", () => {
    it("starts with zero metrics", () => {
      const metrics = service.getBandwidthMetrics();
      expect(metrics.totalPayloadsSent).toBe(0);
      expect(metrics.totalBytesUncompressed).toBe(0);
      expect(metrics.totalBytesCompressed).toBe(0);
      expect(metrics.averageCompressionRatio).toBe(0);
    });

    it("tracks compression metrics across multiple compressions", async () => {
      const largeObj: Record<string, string> = {};
      for (let i = 0; i < 200; i++) {
        largeObj[`f${i}`] = "x".repeat(30);
      }
      const payload = JSON.stringify(largeObj);

      await service.maybeCompress(payload);
      await service.maybeCompress(payload);

      const metrics = service.getBandwidthMetrics();
      expect(metrics.totalPayloadsSent).toBe(2);
      expect(metrics.totalBytesUncompressed).toBeGreaterThan(0);
      expect(metrics.totalBytesCompressed).toBeGreaterThan(0);
      expect(metrics.averageCompressionRatio).toBeLessThan(1);
    });

    it("resets metrics", async () => {
      const largeObj: Record<string, string> = {};
      for (let i = 0; i < 200; i++) {
        largeObj[`f${i}`] = "x".repeat(30);
      }
      await service.maybeCompress(JSON.stringify(largeObj));

      service.resetBandwidthMetrics();
      const metrics = service.getBandwidthMetrics();
      expect(metrics.totalPayloadsSent).toBe(0);
      expect(metrics.averageCompressionRatio).toBe(0);
    });

    it("counts non-compressed payloads as metrics", async () => {
      await service.maybeCompress(JSON.stringify({ small: true }));

      const metrics = service.getBandwidthMetrics();
      expect(metrics.totalPayloadsSent).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  describe("reset", () => {
    it("clears all state", async () => {
      service.setSnapshot("tx-1", { status: "a" });
      service.computeDelta("tx-1", { id: "tx-1", status: "b" });

      service.reset();

      expect(service.getSnapshot("tx-1")).toBeNull();
      expect(service.getBandwidthMetrics().totalPayloadsSent).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Delta validation (#639)
  // ---------------------------------------------------------------------------

  describe("delta validation", () => {
    const base: TransactionSnapshot = {
      id: "tx-1",
      status: "pending",
      amount: "100",
      provider: "mtn",
    };

    const target: TransactionSnapshot = {
      id: "tx-1",
      status: "completed",
      amount: "100",
    };

    const delta: TransactionDelta = {
      id: "tx-1",
      changedFields: { status: "completed" },
      removedFields: ["provider"],
      sequenceNumber: 1,
      timestamp: Date.now(),
    };

    it("applyDelta reconstructs the target snapshot", () => {
      expect(applyDelta(base, delta)).toEqual(target);
    });

    it("validateDelta confirms base + delta === target", () => {
      const result = validateDelta(base, target, delta);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.reconstructed).toEqual(target);
    });

    it("validateDelta reports field mismatches", () => {
      const corrupted: TransactionDelta = {
        ...delta,
        changedFields: { status: "failed" },
      };

      const result = validateDelta(base, target, corrupted);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "field mismatch after applying delta: status",
      );
    });

    it("validateDelta reports fields that were not removed", () => {
      const result = validateDelta(base, target, {
        ...delta,
        removedFields: [],
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("provider"))).toBe(true);
    });

    it("validateDelta reports missing fields", () => {
      const result = validateDelta(base, target, {
        ...delta,
        changedFields: {},
        removedFields: [],
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "field mismatch after applying delta: status",
      );
    });

    it("round-trips a computed delta", () => {
      const previous = service.getSnapshot("tx-round-trip") ?? {
        id: "tx-round-trip",
        status: "pending",
        amount: "50",
      };

      service.setSnapshot("tx-round-trip", previous);
      const next: TransactionSnapshot = {
        ...previous,
        status: "completed",
        amount: "75",
      };
      const computed = service.computeDelta("tx-round-trip", next);

      expect(computed).not.toBeNull();
      const result = validateDelta(previous, next, computed!);
      expect(result.valid).toBe(true);
    });

    it("logs and counts validation failures", () => {
      const logger = require("../../src/utils/logger").default;
      const errorSpy = jest.spyOn(logger, "error").mockImplementation();

      const result = service.validateDelta("tx-1", base, target, {
        ...delta,
        changedFields: { status: "failed" },
      });

      expect(result.valid).toBe(false);
      expect(service.getDeltaValidationFailureCount()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: "tx-1" }),
        "Transaction delta validation failed",
      );

      errorSpy.mockRestore();
    });

    it("resets the validation failure count", () => {
      service.validateDelta("tx-1", base, target, {
        ...delta,
        changedFields: { status: "failed" },
      });
      expect(service.getDeltaValidationFailureCount()).toBe(1);

      service.reset();
      expect(service.getDeltaValidationFailureCount()).toBe(0);
    });
  });
});
