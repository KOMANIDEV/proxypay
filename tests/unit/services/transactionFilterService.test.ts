/**
 * #480 – Advanced Transaction Filtering
 *
 * The compiler is the security boundary of this feature, so most of these
 * tests are about what it refuses: unknown fields, inverted ranges, runaway
 * nesting and injected SQL. If a filter expression can influence the shape of
 * the query rather than only its bound parameters, that is a vulnerability.
 */

jest.mock("../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

import { queryRead, queryWrite } from "../src/config/database";
import {
  FILTERABLE_FIELDS,
  FilterValidationError,
  compileFilterExpression,
  filtersToExpression,
  parseFilterExpression,
} from "../src/services/transactionFilterService";
import type { FilterNode } from "../src/services/transactionFilterService";

const mockRead = queryRead as jest.Mock;
const mockWrite = queryWrite as jest.Mock;

describe("advanced transaction filtering (#480)", () => {
  describe("parseFilterExpression", () => {
    it("accepts a nested boolean expression", () => {
      const node = parseFilterExpression({
        type: "and",
        conditions: [
          { type: "range", field: "amount", min: 1000 },
          {
            type: "or",
            conditions: [
              { type: "compare", field: "status", operator: "eq", value: "failed" },
              { type: "compare", field: "provider", operator: "eq", value: "momo" },
            ],
          },
        ],
      });

      expect(node.type).toBe("and");
      expect((node as { conditions: FilterNode[] }).conditions).toHaveLength(2);
    });

    it("rejects an inverted range at parse time", () => {
      // Failing here means the client gets a clear error, rather than an empty
      // result set that looks like missing data.
      expect(() =>
        parseFilterExpression({
          type: "range",
          field: "amount",
          min: 500,
          max: 100,
        }),
      ).toThrow(FilterValidationError);
    });

    it("rejects a date range that ends before it starts", () => {
      expect(() =>
        parseFilterExpression({
          type: "dateRange",
          field: "createdAt",
          start: "2026-09-10T00:00:00.000Z",
          end: "2026-09-01T00:00:00.000Z",
        }),
      ).toThrow(/starts after it ends/);
    });

    it("rejects an unknown node type", () => {
      expect(() => parseFilterExpression({ type: "sql", value: "1=1" })).toThrow();
    });

    it("rejects an expression nested beyond the depth limit", () => {
      // Depth limit: a 10-deep nest must be refused, not compiled.
      let deep: any = { type: "compare", field: "status", operator: "eq", value: "x" };
      for (let i = 0; i < 10; i += 1) {
        deep = { type: "not", condition: deep };
      }
      expect(() => parseFilterExpression(deep)).toThrow(/depth/);
    });

    it("rejects an expression with too many conditions", () => {
      const conditions = Array.from({ length: 120 }, () => ({
        type: "compare",
        field: "status",
        operator: "eq",
        value: "completed",
      }));
      expect(() =>
        parseFilterExpression({ type: "and", conditions }),
      ).toThrow(/maximum of 100 conditions/);
    });
  });

  describe("compileFilterExpression", () => {
    it("compiles a comparison into a bound parameter, not a literal", () => {
      const compiled = compileFilterExpression({
        type: "compare",
        field: "provider",
        operator: "eq",
        value: "momo",
      });

      expect(compiled.sql).toBe("(provider = $1)");
      expect(compiled.params).toEqual(["momo"]);
      // The value must never appear in the SQL text.
      expect(compiled.sql).not.toContain("momo");
    });

    it("rejects a field that is not in the whitelist", () => {
      expect(() =>
        compileFilterExpression({
          type: "compare",
          field: "amount; DROP TABLE transactions",
          operator: "eq",
          value: 1,
        }),
      ).toThrow(/Unknown filter field/);
    });

    it("maps whitelisted client field names to real columns", () => {
      const compiled = compileFilterExpression({
        type: "compare",
        field: "referenceNumber",
        operator: "eq",
        value: "TXN-1",
      });

      expect(compiled.sql).toBe("(reference_number = $1)");
    });

    it("compiles a range into both bounds", () => {
      const compiled = compileFilterExpression({
        type: "range",
        field: "amount",
        min: 10,
        max: 20,
      });

      expect(compiled.sql).toBe("(amount >= $1 AND amount <= $2)");
      expect(compiled.params).toEqual([10, 20]);
    });

    it("compiles an open-ended range with one bound", () => {
      const compiled = compileFilterExpression({
        type: "range",
        field: "amount",
        min: 100,
      });

      expect(compiled.sql).toBe("(amount >= $1)");
    });

    it("refuses a range with no bounds", () => {
      expect(() =>
        compileFilterExpression({ type: "range", field: "amount" }),
      ).toThrow(/at least one bound/);
    });

    it("requires a numeric value for numeric fields", () => {
      expect(() =>
        compileFilterExpression({
          type: "compare",
          field: "amount",
          operator: "gt",
          value: "abc",
        }),
      ).toThrow(/requires a numeric value/);
    });

    it("joins AND conditions with AND", () => {
      const compiled = compileFilterExpression({
        type: "and",
        conditions: [
          { type: "compare", field: "provider", operator: "eq", value: "momo" },
          { type: "compare", field: "status", operator: "eq", value: "failed" },
        ],
      });

      expect(compiled.sql).toBe("((provider = $1) AND (status = $2))");
    });

    it("joins OR conditions with OR", () => {
      const compiled = compileFilterExpression({
        type: "or",
        conditions: [
          { type: "compare", field: "status", operator: "eq", value: "failed" },
          { type: "compare", field: "status", operator: "eq", value: "dispute" },
        ],
      });

      expect(compiled.sql).toBe("((status = $1) OR (status = $2))");
    });

    it("negates a nested group for NOT", () => {
      const compiled = compileFilterExpression({
        type: "not",
        condition: {
          type: "and",
          conditions: [
            { type: "compare", field: "provider", operator: "eq", value: "momo" },
            { type: "compare", field: "status", operator: "eq", value: "failed" },
          ],
        },
      });

      expect(compiled.sql).toBe("NOT ((provider = $1) AND (status = $2))");
    });

    it("numbers placeholders from the supplied start index", () => {
      // The fragment is spliced into a larger query, so numbering has to
      // continue from where the caller already is.
      const compiled = compileFilterExpression(
        {
          type: "and",
          conditions: [
            { type: "compare", field: "provider", operator: "eq", value: "momo" },
            { type: "compare", field: "status", operator: "eq", value: "failed" },
          ],
        },
        4,
      );

      expect(compiled.sql).toBe("((provider = $4) AND (status = $5))");
    });

    it("escapes wildcards in a text search", () => {
      // Searching for "50%" must not become a match-everything pattern.
      const compiled = compileFilterExpression({
        type: "text",
        field: "referenceNumber",
        operator: "contains",
        value: "50%",
      });

      expect(compiled.sql).toContain("ESCAPE");
      expect(compiled.params[0]).toBe("%50\\%%");
    });

    it("uses the right pattern for startsWith", () => {
      const compiled = compileFilterExpression({
        type: "text",
        field: "referenceNumber",
        operator: "startsWith",
        value: "TXN",
      });

      expect(compiled.params[0]).toBe("TXN%");
    });

    it("compiles an IN list into an array parameter", () => {
      const compiled = compileFilterExpression({
        type: "in",
        field: "status",
        values: ["failed", "dispute"],
      });

      expect(compiled.sql).toBe("(status = ANY($1))");
      expect(compiled.params).toEqual([["failed", "dispute"]]);
    });

    it("casts temporal comparisons so dates compare as dates", () => {
      const compiled = compileFilterExpression({
        type: "dateRange",
        field: "createdAt",
        start: "2026-09-01T00:00:00.000Z",
      });

      expect(compiled.sql).toBe("(created_at >= $1)");
      expect(compiled.params[0]).toBe("2026-09-01T00:00:00.000Z");
    });

    it("compiles metadata key presence using the GIN-friendly operator", () => {
      const compiled = compileFilterExpression({
        type: "exists",
        metadataKey: "device_id",
        value: true,
      });

      expect(compiled.sql).toBe("(metadata ? $1)");
      expect(compiled.params).toEqual(["device_id"]);
    });

    it("compiles the absence of a metadata key as NOT", () => {
      const compiled = compileFilterExpression({
        type: "exists",
        metadataKey: "device_id",
        value: false,
      });

      expect(compiled.sql).toBe("(NOT (metadata ? $1))");
    });
  });

  describe("filtersToExpression", () => {
    it("maps the legacy flat filters onto the AST", () => {
      const node = filtersToExpression({
        minAmount: 100,
        maxAmount: 500,
        provider: "momo",
        statuses: ["failed" as never],
        referenceNumber: "TXN-1",
      });

      expect(node).not.toBeNull();
      expect(node?.type).toBe("and");
      expect((node as { conditions: FilterNode[] }).conditions).toHaveLength(4);
    });

    it("returns null when there is nothing to filter on", () => {
      expect(filtersToExpression({})).toBeNull();
    });

    it("collapses a single condition instead of wrapping it", () => {
      const node = filtersToExpression({ provider: "momo" });
      expect(node).toEqual({
        type: "compare",
        field: "provider",
        operator: "eq",
        value: "momo",
      });
    });
  });

  describe("filterable field catalogue", () => {
    it("only exposes known columns", () => {
      for (const [name, meta] of Object.entries(FILTERABLE_FIELDS)) {
        expect(meta.column).toMatch(/^[a-z_]+$/);
        expect(name).toMatch(/^[a-zA-Z]+$/);
      }
    });

    it("covers the fields the dashboard filters on", () => {
      expect(Object.keys(FILTERABLE_FIELDS)).toEqual(
        expect.arrayContaining([
          "amount",
          "status",
          "provider",
          "createdAt",
          "currency",
          "tag",
        ]),
      );
    });
  });

  describe("saved templates", () => {
    it("validates the expression before persisting it", async () => {
      const { createFilterTemplate } = await import(
        "../src/services/transactionFilterService"
      );

      // A stored expression that cannot compile is worse than no template.
      await expect(
        createFilterTemplate({
          name: "Broken",
          expression: { type: "range", field: "amount", min: 10, max: 1 },
        }),
      ).rejects.toThrow(FilterValidationError);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it("records template usage so the counters stay accurate", async () => {
      const { recordTemplateUsage } = await import(
        "../src/services/transactionFilterService"
      );
      mockWrite.mockResolvedValue({ rows: [], rowCount: 1 });

      await recordTemplateUsage("template-1", "user-1", 42);

      expect(mockWrite).toHaveBeenCalledTimes(2);
      expect(mockWrite.mock.calls[0][0]).toContain("usage_count = usage_count + 1");
      expect(mockWrite.mock.calls[1][0]).toContain(
        "INSERT INTO transaction_filter_usage",
      );
    });
  });
});
