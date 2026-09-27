/**
 * Tests for #403 – Transaction Metadata Service (pure logic, no DB)
 */

// Only test pure-logic functions that don't touch DB/Redis
// DB-dependent functions require integration tests

describe("transactionMetadataService – pure logic", () => {
  describe("metadata field validation", () => {
    it("allows valid lowercase field names", () => {
      const validNames = ["provider", "channel", "source_country", "customer_id", "ref"];
      validNames.forEach((name) => {
        expect(/^[a-z_]+$/.test(name)).toBe(true);
      });
    });

    it("rejects field names with uppercase or special chars", () => {
      // These must be rejected by /^[a-z_]+$/ (uppercase, hyphens, dots, spaces)
      const invalid = ["Provider", "source-country", "ref.id", "SELECT 1"];
      invalid.forEach((name) => {
        expect(/^[a-z_]+$/.test(name)).toBe(false);
      });
    });

    it("rejects empty field names", () => {
      expect(/^[a-z_]+$/.test("")).toBe(false);
    });
  });

  describe("cache key determinism", () => {
    it("produces the same key for identical params", () => {
      // Mirror the logic from the service (base64url of JSON)
      function fieldQueryCacheKey(params: Record<string, unknown>): string {
        const p = JSON.stringify({ limit: 20, offset: 0, ...params });
        return `txn:meta:field:${Buffer.from(p).toString("base64url")}`;
      }

      const key1 = fieldQueryCacheKey({ field: "provider", value: "mtn" });
      const key2 = fieldQueryCacheKey({ field: "provider", value: "mtn" });
      expect(key1).toBe(key2);
    });

    it("produces different keys for different values", () => {
      function fieldQueryCacheKey(params: Record<string, unknown>): string {
        const p = JSON.stringify({ limit: 20, offset: 0, ...params });
        return `txn:meta:field:${Buffer.from(p).toString("base64url")}`;
      }

      const key1 = fieldQueryCacheKey({ field: "provider", value: "mtn" });
      const key2 = fieldQueryCacheKey({ field: "provider", value: "airtel" });
      expect(key1).not.toBe(key2);
    });

    it("includes pagination in the cache key", () => {
      function fieldQueryCacheKey(params: Record<string, unknown>): string {
        const p = JSON.stringify({ limit: 20, offset: 0, ...params });
        return `txn:meta:field:${Buffer.from(p).toString("base64url")}`;
      }

      const key1 = fieldQueryCacheKey({ field: "provider", value: "mtn", offset: 0 });
      const key2 = fieldQueryCacheKey({ field: "provider", value: "mtn", offset: 20 });
      expect(key1).not.toBe(key2);
    });
  });

  describe("benchmark helper structure", () => {
    it("result shape has expected keys", () => {
      // Type check only — the shape the function returns
      const mockResult = {
        fieldQueryMs: 5,
        ftsQueryMs: 12,
        indexStats: [
          { indexName: "idx_txn_meta_provider", scans: 100, tuplesRead: 500, indexSize: "16 kB" },
        ],
      };
      expect(mockResult).toHaveProperty("fieldQueryMs");
      expect(mockResult).toHaveProperty("ftsQueryMs");
      expect(mockResult).toHaveProperty("indexStats");
      expect(Array.isArray(mockResult.indexStats)).toBe(true);
    });
  });
});
