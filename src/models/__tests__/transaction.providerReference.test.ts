/**
 * Tests for #643 – Withdrawal Confirmation Provider Reference Mapping
 *
 * Validates that:
 *  - TransactionModel.updateProviderReference() persists the provider reference
 *  - TransactionModel.findByProviderReference() enables bidirectional lookup
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockQueryWrite = jest.fn<any>();
const mockQueryRead = jest.fn<any>();

jest.mock("../../config/database", () => ({
  queryRead: (...args: any[]) => mockQueryRead(...args),
  queryWrite: (...args: any[]) => mockQueryWrite(...args),
  pool: { query: jest.fn<any>() },
}));

jest.mock("../../utils/encryption", () => ({
  encrypt: (v: any) => v,
  decrypt: (v: any) => v,
  hashSearchValue: (v: any) => v,
}));

jest.mock("../../utils/referenceGenerator", () => ({
  generateReferenceNumber: jest.fn<any>().mockResolvedValue("REF-001"),
}));

jest.mock("../../websocket", () => ({
  WebSocketManager: { getInstance: jest.fn<any>().mockReturnValue(null) },
}));

jest.mock("../../graphql/redisPubSub", () => ({
  getRedisPubSub: jest.fn<any>().mockReturnValue({
    publish: jest.fn<any>().mockResolvedValue(undefined),
  }),
}));

jest.mock("../../services/cachedTransactionService", () => ({
  CachedTransactionInvalidation: {
    invalidateUserCaches: jest.fn<any>().mockResolvedValue(undefined),
    invalidateProviderStats: jest.fn<any>().mockResolvedValue(undefined),
    invalidateGeneralStats: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

jest.mock("../../graphql/subscriptions", () => ({
  SubscriptionChannels: { TRANSACTION_UPDATED: "transaction_updated" },
  transactionChannel: (id: string) => `transaction:${id}`,
}));

import { TransactionModel } from "../transaction";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRANSACTION_ROW = {
  id: "tx-001",
  reference_number: "REF-001",
  provider_reference: null,
  type: "withdraw",
  amount: "5000",
  phone_number: "+237677000000",
  provider: "mtn",
  stellar_address: "GABCDEF",
  status: "completed",
  tags: [],
  notes: null,
  admin_notes: null,
  metadata: {},
  location_metadata: null,
  user_id: "user-001",
  idempotency_key: null,
  idempotency_expires_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TransactionModel.updateProviderReference (#643)", () => {
  let model: TransactionModel;

  beforeEach(() => {
    jest.clearAllMocks();
    model = new TransactionModel();
  });

  it("executes an UPDATE setting provider_reference on the given transaction", async () => {
    const updatedRow = { ...TRANSACTION_ROW, provider_reference: "MTN-REF-XYZ" };
    mockQueryWrite.mockResolvedValueOnce({ rows: [updatedRow] });

    const result = await model.updateProviderReference("tx-001", "MTN-REF-XYZ");

    // Verify the write query was called
    expect(mockQueryWrite).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQueryWrite.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE transactions/i);
    expect(sql).toMatch(/provider_reference/i);
    expect(params).toContain("MTN-REF-XYZ");
    expect(params).toContain("tx-001");

    // Result should carry the new reference
    expect(result).not.toBeNull();
  });

  it("returns null when the transaction does not exist", async () => {
    mockQueryWrite.mockResolvedValueOnce({ rows: [] });

    const result = await model.updateProviderReference("nonexistent", "REF");
    expect(result).toBeNull();
  });
});

describe("TransactionModel.findByProviderReference (#643)", () => {
  let model: TransactionModel;

  beforeEach(() => {
    jest.clearAllMocks();
    model = new TransactionModel();
  });

  it("queries by provider_reference and returns the matching transaction", async () => {
    const row = { ...TRANSACTION_ROW, provider_reference: "MTN-REF-XYZ" };
    mockQueryRead.mockResolvedValueOnce({ rows: [row] });

    const result = await model.findByProviderReference("MTN-REF-XYZ");

    expect(mockQueryRead).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQueryRead.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/provider_reference/i);
    expect(params).toContain("MTN-REF-XYZ");
    expect(result).not.toBeNull();
  });

  it("returns null when no transaction matches the provider reference", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [] });

    const result = await model.findByProviderReference("UNKNOWN-REF");
    expect(result).toBeNull();
  });

  it("enables bidirectional lookup – find the transaction stored by updateProviderReference", async () => {
    // Simulate: updateProviderReference writes, findByProviderReference reads
    const rowWithRef = { ...TRANSACTION_ROW, provider_reference: "PROV-123" };
    mockQueryWrite.mockResolvedValueOnce({ rows: [rowWithRef] });
    mockQueryRead.mockResolvedValueOnce({ rows: [rowWithRef] });

    await model.updateProviderReference("tx-001", "PROV-123");
    const found = await model.findByProviderReference("PROV-123");

    expect(found).not.toBeNull();
  });
});
