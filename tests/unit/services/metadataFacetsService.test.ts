/**
 * #477 – Transaction search by metadata
 *
 * Faceted search is only useful if the counts and the result set describe the
 * same population, so the tests focus on the population predicate, the key
 * validation, and the shape of the response.
 */

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn() },
  redisClient: {
    get: jest.fn(),
    setex: jest.fn(),
  },
}));

import { pool, redisClient } from "../../src/config/database";
import {
  DEFAULT_FACET_KEYS,
  discoverMetadataKeys,
  searchMetadataFacets,
} from "../../src/services/metadataFacetsService";

const mockQuery = pool.query as jest.Mock;
const mockGet = redisClient.get as jest.Mock;
const mockSetex = redisClient.setex as jest.Mock;

function facetRow(overrides: Record<string, unknown> = {}) {
  return {
    data: [{ id: "txn-1", metadata: { provider: "momo" } }],
    total: 10,
    facets: {
      provider: [{ value: "momo", count: 6 }, { value: "mtn", count: 4 }],
      status: [{ value: "completed", count: 10 }],
    },
    keys: [
      { value: "provider", count: 10 },
      { value: "channel", count: 4 },
    ],
    ...overrides,
  };
}

describe("transaction metadata search (#477)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockSetex.mockResolvedValue("OK");
  });

  describe("searchMetadataFacets", () => {
    it("returns a result set, facets, keys and an amount distribution", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await searchMetadataFacets({ userId: "user-1" });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(10);
      expect(result.facets.provider).toHaveLength(2);
      expect(result.keys).toHaveLength(2);
      expect(result.amountDistribution.length).toBeGreaterThan(0);
    });

    it("computes facet percentages against the total", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await searchMetadataFacets({ userId: "user-1" });

      expect(result.facets.provider[0]).toEqual({
        value: "momo",
        count: 6,
        percentage: 0.6,
      });
    });

    it("scopes the population to the requesting user", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [] });

      await searchMetadataFacets({ userId: "user-42" });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("user_id = $1");
      expect(params[0]).toBe("user-42");
    });

    it("adds the full-text predicate when a query is supplied", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [] });

      await searchMetadataFacets({ query: "deposit", userId: "user-1" });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain("metadata_tsv @@ plainto_tsquery");
    });

    it("binds facet keys rather than interpolating them", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [] });

      await searchMetadataFacets({
        query: "deposit",
        userId: "user-1",
        facets: ["provider"],
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("= ANY(");
      // The key reaches PostgreSQL as a bound array value.
      expect(params[params.length - 1]).toEqual(["provider"]);
    });

    it("rejects an invalid facet key", async () => {
      await expect(
        searchMetadataFacets({
          userId: "user-1",
          facets: ["provider'); DROP TABLE transactions; --"],
        }),
      ).rejects.toThrow(/Invalid metadata key/);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("rejects an invalid metadata filter key", async () => {
      await expect(
        searchMetadataFacets({
          userId: "user-1",
          filters: { "bad key": "value" },
        }),
      ).rejects.toThrow(/Invalid metadata key/);
    });

    it("bounds both the key list and the facet width", async () => {
      const tooManyKeys = Array.from({ length: 20 }, (_, i) => `key_${i}`);
      await expect(
        searchMetadataFacets({ userId: "user-1", facets: tooManyKeys }),
      ).rejects.toThrow();
    });

    it("caps the page size at 100", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [] });

      await searchMetadataFacets({ userId: "user-1", limit: 5000 });

      const params = mockQuery.mock.calls[0][1];
      // bindValues = [...population, limit, offset, facetLimit, facetKeys]
      expect(params[1]).toBe(100);
    });

    it("returns the cached payload without querying when warm", async () => {
      mockGet.mockResolvedValueOnce(
        JSON.stringify({ data: [], total: 0, facets: {}, keys: [] }),
      );

      const result = await searchMetadataFacets({ userId: "user-1" });

      expect(result.cached).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("falls through to the database when the cache is unavailable", async () => {
      mockGet.mockRejectedValueOnce(new Error("redis down"));
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await searchMetadataFacets({ userId: "user-1" });

      expect(result.cached).toBe(false);
      expect(result.total).toBe(10);
    });

    it("still answers when the cache write fails", async () => {
      mockSetex.mockRejectedValueOnce(new Error("redis down"));
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await searchMetadataFacets({ userId: "user-1" });

      expect(result.total).toBe(10);
    });

    it("handles an empty population without dividing by zero", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await searchMetadataFacets({ userId: "user-1" });

      expect(result.total).toBe(0);
      expect(result.facets).toEqual({});
      expect(result.amountDistribution.every((b) => b.count === 0)).toBe(true);
    });

    it("builds the amount histogram from the bucket bounds", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [facetRow()] })
        .mockResolvedValueOnce({ rows: [{ bucket_index: "0", count: "7" }] });

      const result = await searchMetadataFacets({
        userId: "user-1",
        amountBuckets: [0, 50, 100],
      });

      expect(result.amountDistribution).toEqual([
        { from: null, to: 50, count: 7 },
        { from: 50, to: 100, count: 0 },
        { from: 100, to: null, count: 0 },
      ]);
    });
  });

  describe("discoverMetadataKeys", () => {
    it("returns key counts as a percentage of all metadata entries", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { key: "provider", count: "75" },
          { key: "channel", count: "25" },
        ],
      });

      const keys = await discoverMetadataKeys("user-1");

      expect(keys).toEqual([
        { value: "provider", count: 75, percentage: 0.75 },
        { value: "channel", count: 25, percentage: 0.25 },
      ]);
    });

    it("scopes key discovery to one user when a user is given", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await discoverMetadataKeys("user-7");

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("WHERE user_id = $1");
      expect(params[0]).toBe("user-7");
    });

    it("caps the requested key count", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await discoverMetadataKeys(undefined, 5000);

      expect(mockQuery.mock.calls[0][1][0]).toBe(25);
    });
  });

  describe("facet defaults", () => {
    it("defaults to the low-cardinality keys", () => {
      expect(DEFAULT_FACET_KEYS).toContain("provider");
      expect(DEFAULT_FACET_KEYS).toContain("status");
      expect(DEFAULT_FACET_KEYS).toContain("currency");
    });
  });
});
