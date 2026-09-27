/**
 * Compound / OR status filtering tests (Issue #633).
 *
 * Covers multiple status values in one query, named status ranges
 * (e.g. terminal states) and the SQL OR clause they produce.
 */

import request from "supertest";
import express, { Express, Router } from "express";
import {
  ACTIVE_STATUSES,
  STATUS_RANGES,
  TERMINAL_STATUSES,
  TransactionStatus,
  VALID_STATUSES,
  buildStatusWhereClause,
  expandStatusTokens,
  isTerminalStatus,
  parseStatusFilter,
  validateTransactionFilters,
} from "../src/utils/transactionFilters";

describe("Transaction Status Filtering - Compound Filters (Issue #633)", () => {
  describe("parseStatusFilter", () => {
    it("supports an OR of multiple statuses in a single query", () => {
      expect(parseStatusFilter("completed,failed")).toEqual([
        TransactionStatus.Completed,
        TransactionStatus.Failed,
      ]);
    });

    it("expands the terminal status range", () => {
      expect(parseStatusFilter("terminal")).toEqual(TERMINAL_STATUSES);
    });

    it("expands the active status range", () => {
      expect(parseStatusFilter("active")).toEqual(ACTIVE_STATUSES);
    });

    it("expands success/failure ranges", () => {
      expect(parseStatusFilter("success")).toEqual([
        TransactionStatus.Completed,
      ]);
      expect(parseStatusFilter("failure")).toEqual(STATUS_RANGES.failure);
    });

    it("combines ranges and explicit statuses without duplicates", () => {
      const result = parseStatusFilter("terminal,review,completed");
      expect(result).toEqual([
        ...TERMINAL_STATUSES,
        TransactionStatus.Review,
      ]);
      expect(new Set(result).size).toBe(result.length);
    });

    it("is case-insensitive for range names", () => {
      expect(parseStatusFilter("TERMINAL")).toEqual(TERMINAL_STATUSES);
    });

    it("rejects unknown ranges", () => {
      expect(() => parseStatusFilter("nonsense")).toThrow(/Invalid status/);
    });
  });

  describe("expandStatusTokens", () => {
    it("de-duplicates expanded statuses", () => {
      expect(expandStatusTokens(["pending", "pending"])).toEqual([
        TransactionStatus.Pending,
      ]);
    });

    it("throws when a mix of valid and invalid tokens is supplied", () => {
      expect(() => expandStatusTokens(["terminal", "bogus"])).toThrow(
        /Invalid status values: bogus/,
      );
    });
  });

  describe("buildStatusWhereClause", () => {
    it("builds an OR (SQL IN) clause for terminal states", () => {
      const clause = buildStatusWhereClause(TERMINAL_STATUSES);
      const expected = `status IN (${TERMINAL_STATUSES.map(
        (status) => `'${status}'`,
      ).join(", ")})`;

      expect(clause).toBe(expected);
      expect(clause).toMatch(/^status IN \((?:'[a-z_]+'(?:, )?)+\)$/);
    });

    it("deduplicates repeated statuses", () => {
      expect(
        buildStatusWhereClause([
          TransactionStatus.Pending,
          TransactionStatus.Pending,
        ]),
      ).toBe("status IN ('pending')");
    });

    it("returns an empty clause when every status is selected", () => {
      expect(buildStatusWhereClause(VALID_STATUSES)).toBe("");
    });
  });

  it("classifies terminal statuses", () => {
    expect(isTerminalStatus(TransactionStatus.Completed)).toBe(true);
    expect(isTerminalStatus(TransactionStatus.Failed)).toBe(true);
    expect(isTerminalStatus(TransactionStatus.Cancelled)).toBe(true);
    expect(isTerminalStatus(TransactionStatus.Pending)).toBe(false);
  });

  describe("validateTransactionFilters middleware", () => {
    let app: Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
    });

    it("accepts a status range in a query", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters, (req, res) => {
        expect((req as any).transactionFilters.statuses).toEqual(
          ACTIVE_STATUSES,
        );
        res.json({ success: true });
      });
      app.use(router);

      request(app)
        .get("/?status=active")
        .expect(200)
        .expect({ success: true }, done);
    });

    it("rejects an unknown status range", (done) => {
      const router = Router();
      router.get("/", validateTransactionFilters);
      app.use(router);

      request(app)
        .get("/?status=nonsense")
        .expect(400)
        .expect((res: any) => {
          expect(res.body.error).toContain("Invalid status");
        })
        .end(done);
    });
  });
});
