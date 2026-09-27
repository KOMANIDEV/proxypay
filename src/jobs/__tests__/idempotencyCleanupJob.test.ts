/**
 * Tests for the idempotency key cleanup job.
 *
 * Covers the TTL-based deletion of expired keys, the purge of orphaned
 * `in_progress` keys left behind by timed-out requests, and the job entry point
 * that runs both phases (issues #357 / #619).
 */

const mockPoolQuery = jest.fn();

jest.mock("../../config/database", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  purgeExpiredIdempotencyKeys,
  purgeStaleInProgressKeys,
  runIdempotencyCleanupJob,
} from "../idempotencyCleanupJob";

const deleteCalls = () =>
  mockPoolQuery.mock.calls.filter(([sql]) =>
    String(sql).includes("DELETE FROM idempotency_keys"),
  );

describe("idempotency key cleanup job", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  describe("purgeExpiredIdempotencyKeys", () => {
    it("deletes expired keys in batches until a partial batch is returned", async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rowCount: 500 }) // full batch → keep going
        .mockResolvedValueOnce({ rowCount: 120 }) // partial batch → stop
        .mockResolvedValueOnce({
          rows: [{ in_progress: "3", completed: "7", total: "10" }],
        });

      const purged = await purgeExpiredIdempotencyKeys();

      expect(purged).toBe(620);
      expect(deleteCalls()).toHaveLength(2);
      expect(String(deleteCalls()[0][0])).toContain(
        "expires_at <= CURRENT_TIMESTAMP",
      );
    });

    it("does not loop when nothing is expired", async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{}] });

      await expect(purgeExpiredIdempotencyKeys()).resolves.toBe(0);
      expect(deleteCalls()).toHaveLength(1);
    });
  });

  describe("purgeStaleInProgressKeys", () => {
    it("purges keys abandoned by timed-out requests", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 4 });

      await expect(purgeStaleInProgressKeys()).resolves.toBe(4);

      const [sql] = deleteCalls()[0];
      expect(String(sql)).toContain("state = 'in_progress'");
      expect(String(sql)).toContain("created_at <");
    });

    it("returns 0 instead of throwing when the purge fails", async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error("connection reset"));

      await expect(purgeStaleInProgressKeys()).resolves.toBe(0);
    });
  });

  describe("runIdempotencyCleanupJob", () => {
    it("runs both cleanup phases", async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rowCount: 0 }) // expired keys
        .mockResolvedValueOnce({
          rows: [{ in_progress: "0", completed: "0", total: "0" }],
        })
        .mockResolvedValueOnce({ rowCount: 2 }); // stale in-progress keys

      await expect(runIdempotencyCleanupJob()).resolves.toBeUndefined();
      expect(deleteCalls()).toHaveLength(2);
    });
  });
});
