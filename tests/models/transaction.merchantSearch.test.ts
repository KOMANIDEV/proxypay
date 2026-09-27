/**
 * Model tests for the merchant filter on transaction search (issue #621).
 */

const mockQueryRead = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn() },
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: jest.fn(),
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

import { TransactionModel } from "../../src/models/transaction";

const lastSearchCall = (): { sql: string; params: unknown[] } => {
  const [sql, params] = mockQueryRead.mock.calls[0];
  return { sql: String(sql), params: params as unknown[] };
};

describe("transaction search merchant filter (#621)", () => {
  beforeEach(() => {
    mockQueryRead.mockReset();
    mockQueryRead.mockResolvedValue({ rows: [] });
  });

  it("filters by a single merchant id", async () => {
    await new TransactionModel().searchByPhoneNumber("+237600000000", 10, 0, [
      "merchant-1",
    ]);

    const { sql, params } = lastSearchCall();
    expect(sql).toContain("merchant_id = ANY($2::uuid[])");
    expect(params).toEqual(["hash:237600000000", ["merchant-1"], 10, 0]);
  });

  it("supports several merchant ids in one query", async () => {
    await new TransactionModel().searchByPhoneNumber("+237600000000", 10, 0, [
      "merchant-1",
      "merchant-2",
    ]);

    const { params } = lastSearchCall();
    expect(params).toEqual([
      "hash:237600000000",
      ["merchant-1", "merchant-2"],
      10,
      0,
    ]);
  });

  it("omits the merchant predicate when no filter is supplied", async () => {
    await new TransactionModel().searchByPhoneNumber("+237600000000", 10, 0);

    const { sql, params } = lastSearchCall();
    expect(sql).not.toContain("merchant_id = ANY");
    expect(params).toEqual(["hash:237600000000", 10, 0]);
  });

  it("clamps the page size and offset without shifting the parameters", async () => {
    await new TransactionModel().searchByPhoneNumber("+237600000000", 500, -5, [
      "merchant-1",
    ]);

    const { params } = lastSearchCall();
    expect(params).toEqual(["hash:237600000000", ["merchant-1"], 100, 0]);
  });
});
