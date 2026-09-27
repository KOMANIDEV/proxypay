/**
 * Tests for idempotency key release when a transaction reaches a terminal state
 * (issue #619) — without this, a recovered timeout keeps a stale key in place
 * that blocks legitimate retries.
 */

const mockQueryWrite = jest.fn();
const mockQueryRead = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn() },
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

jest.mock("../../src/utils/encryption", () => ({
  encrypt: (value: unknown) => value,
  decrypt: (value: unknown) => value,
  hashSearchValue: (value: string) => `hash:${value}`,
}));

jest.mock("../../src/services/cachedTransactionService", () => ({
  CachedTransactionInvalidation: {
    invalidateUserCaches: jest.fn(async () => undefined),
    invalidateProviderStats: jest.fn(async () => undefined),
    invalidateGeneralStats: jest.fn(async () => undefined),
  },
}));

jest.mock("../../src/graphql/redisPubSub", () => ({
  getRedisPubSub: jest.fn(() => ({ publish: jest.fn() })),
}));

jest.mock("../../src/websocket", () => ({
  WebSocketManager: {
    getInstance: jest.fn(() => ({ broadcastTransactionUpdate: jest.fn() })),
  },
}));

import {
  TransactionModel,
  TransactionStatus,
} from "../../src/models/transaction";

const statusRow = {
  user_id: "user-1",
  provider: "mtn",
  reference_number: "TX-1",
  type: "deposit",
  updated_at: new Date().toISOString(),
};

const releaseCalls = () =>
  mockQueryWrite.mock.calls.filter(
    ([sql]) =>
      String(sql).includes("idempotency_key = NULL") &&
      String(sql).includes("WHERE id = $1"),
  );

describe("transaction idempotency key release (#619)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryWrite.mockImplementation(async (sql: string) =>
      String(sql).includes("SET status=$1")
        ? { rowCount: 1, rows: [statusRow] }
        : { rowCount: 1, rows: [] },
    );
  });

  it("releases the idempotency key when a transaction completes", async () => {
    await new TransactionModel().updateStatus(
      "txn-1",
      TransactionStatus.Completed,
    );

    expect(releaseCalls()).toHaveLength(1);
    expect(releaseCalls()[0][1]).toEqual(["txn-1"]);
  });

  it("releases the key when a transaction fails or is cancelled", async () => {
    const model = new TransactionModel();

    await model.updateStatus("txn-2", TransactionStatus.Failed);
    await model.updateStatus("txn-3", TransactionStatus.Cancelled);

    expect(releaseCalls().map((call) => call[1])).toEqual([
      ["txn-2"],
      ["txn-3"],
    ]);
  });

  it("keeps the key while the transaction is still in flight", async () => {
    await new TransactionModel().updateStatus(
      "txn-4",
      TransactionStatus.Pending,
    );

    expect(releaseCalls()).toHaveLength(0);
  });

  it("does not fail the status update when the key release errors", async () => {
    mockQueryWrite.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SET status=$1")) {
        return { rowCount: 1, rows: [statusRow] };
      }
      throw new Error("deadlock detected");
    });

    await expect(
      new TransactionModel().updateStatus("txn-5", TransactionStatus.Completed),
    ).resolves.toBeUndefined();
  });

  it("reports whether a key was actually cleared", async () => {
    const model = new TransactionModel();

    mockQueryWrite.mockResolvedValueOnce({ rowCount: 1 });
    await expect(model.releaseIdempotencyKey("txn-6")).resolves.toBe(true);

    mockQueryWrite.mockResolvedValueOnce({ rowCount: 0 });
    await expect(model.releaseIdempotencyKey("txn-7")).resolves.toBe(false);
  });
});
