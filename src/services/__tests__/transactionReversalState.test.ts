/**
 * #483 – Transaction Reversal Capability
 *
 * Extends the existing reversal coverage with the durable state machine,
 * audit trail and notification behaviour.
 */

import { TransactionStatus } from "../../models/transaction";
import { ledgerService } from "../ledgerService";
import {
  TransactionReversalService,
  ReversalStatus,
} from "../transactionReversalService";
import { queryRead, queryWrite } from "../../config/database";
import { notificationRouter } from "../notificationRouter";

jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../notificationRouter", () => ({
  notificationRouter: { routeNotification: jest.fn() },
}));

const mockedQueryRead = queryRead as jest.Mock;
const mockedQueryWrite = queryWrite as jest.Mock;
const mockedRoute = notificationRouter.routeNotification as jest.Mock;

const transaction = {
  id: "11111111-1111-1111-1111-111111111111",
  referenceNumber: "TXN-001",
  status: TransactionStatus.Failed,
  userId: "user-1",
  type: "deposit",
  amount: "500",
  provider: "mtn",
} as any;

const reversalRow = (overrides: Record<string, any> = {}) => ({
  id: "22222222-2222-2222-2222-222222222222",
  transaction_id: transaction.id,
  original_reference: "TXN-001",
  reversal_reference: null,
  reason: "Provider marked payment failed",
  status: "requested",
  requested_by: "admin-1",
  approved_by: null,
  ledger_entries: 0,
  already_reversed: false,
  error: null,
  notified_at: null,
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

function buildService(statuses: string[] = []) {  const transactionModel = {
    findById: jest
      .fn()
      .mockResolvedValueOnce(transaction)
      .mockResolvedValue({ ...transaction, status: TransactionStatus.Reversed }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };

  const service = new TransactionReversalService(transactionModel as any, true);

  // Status lookups (transition) walk through the supplied state sequence.
  const queue = [...statuses];
  mockedQueryRead.mockImplementation(async (sql: string) => {
    if (String(sql).includes("transaction_reversal_events")) {
      return { rows: [] };
    }
    if (queue.length > 0) {
      return { rows: [reversalRow({ status: queue.shift() })] };
    }
    return { rows: [reversalRow()] };
  });

  mockedQueryWrite.mockImplementation(async (sql: string) => {
    if (String(sql).includes("INSERT INTO transaction_reversals")) {
      return { rows: [reversalRow()], rowCount: 1 };
    }
    return { rows: reversalRow().id ? [reversalRow()] : [], rowCount: 1 };
  });

  return { service, transactionModel };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(ledgerService, "postReversal")
    .mockResolvedValue({ alreadyReversed: false, entries: [{} as any] });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("reverse", () => {
  it("walks the reversal through requested -> posted -> notified", async () => {
    mockedRoute.mockResolvedValue(undefined);
    const { service } = buildService(["requested", "posted"]);

    const result = await service.reverse(
      transaction.id,
      "Provider marked payment failed",
      "admin-1",
    );

    expect(result.notified).toBe(true);
    expect(result.record?.status).toBeDefined();

    const updates = mockedQueryWrite.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => sql.startsWith("UPDATE transaction_reversals"));
    expect(updates.some((sql) => sql.includes("$2"))).toBe(true);
  });

  it("records the compensating reference derived from the original", async () => {
    mockedRoute.mockResolvedValue(undefined);
    const { service } = buildService();

    await service.reverse(transaction.id, "error", "admin-1");

    const update = mockedQueryWrite.mock.calls.find((call) =>
      String(call[0]).startsWith("UPDATE transaction_reversals"),
    );
    expect(update?.[1]).toContain("REV-TXN-001");
  });

  it("appends an audit event for every transition", async () => {
    mockedRoute.mockResolvedValue(undefined);
    const { service } = buildService();

    await service.reverse(transaction.id, "error", "admin-1");

    const auditInserts = mockedQueryWrite.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO transaction_reversal_events"),
    );
    expect(auditInserts.length).toBeGreaterThanOrEqual(3);
  });

  it("marks the reversal as failed and rethrows when the ledger post fails", async () => {
    jest
      .spyOn(ledgerService, "postReversal")
      .mockRejectedValue(new Error("ledger unavailable"));
    const { service } = buildService();

    await expect(service.reverse(transaction.id, "error")).rejects.toThrow(
      "ledger unavailable",
    );

    const update = mockedQueryWrite.mock.calls.find((call) =>
      String(call[0]).startsWith("UPDATE transaction_reversals"),
    );
    expect(update?.[1]).toContain("failed");
  });

  it("does not double-post when the transaction is already reversed", async () => {
    const transactionModel = {
      findById: jest.fn().mockResolvedValue({
        ...transaction,
        status: TransactionStatus.Reversed,
      }),
      updateStatus: jest.fn(),
    };
    const service = new TransactionReversalService(transactionModel as any, false);

    const result = await service.reverse(transaction.id, "retry");

    expect(ledgerService.postReversal).not.toHaveBeenCalled();
    expect(result.reversal.alreadyReversed).toBe(true);
    expect(result.notified).toBe(false);
  });

  it("still surfaces the existing record for an already-reversed transaction", async () => {
    const transactionModel = {
      findById: jest.fn().mockResolvedValue({
        ...transaction,
        status: TransactionStatus.Reversed,
      }),
      updateStatus: jest.fn(),
    };
    const service = new TransactionReversalService(transactionModel as any, true);
    mockedQueryRead.mockResolvedValue({ rows: [reversalRow({ status: "notified" })] });

    const result = await service.reverse(transaction.id, "retry");

    expect(result.record?.status).toBe("notified");
  });

  it("keeps the reversal successful when the notification fails", async () => {
    mockedRoute.mockRejectedValue(new Error("smtp down"));
    const { service, transactionModel } = buildService();

    const result = await service.reverse(transaction.id, "error", "admin-1");

    // The ledger posting and the status update must both have happened even
    // though the announcement could not be delivered.
    expect(result.notified).toBe(false);
    expect(transactionModel.updateStatus).toHaveBeenCalledWith(
      transaction.id,
      TransactionStatus.Reversed,
    );
  });

  it("notifies the merchant with the reversal context", async () => {
    mockedRoute.mockResolvedValue(undefined);
    const { service } = buildService();

    await service.reverse(transaction.id, "duplicate capture", "admin-1");

    expect(mockedRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        category: "transaction",
        title: "Transaction Reversed",
        message: expect.stringContaining("duplicate capture"),
      }),
    );
  });

  it("skips notification for an anonymous transaction", async () => {
    mockedRoute.mockResolvedValue(undefined);
    const transactionModel = {
      findById: jest
        .fn()
        .mockResolvedValueOnce({ ...transaction, userId: null })
        .mockResolvedValue({ ...transaction, userId: null }),
      updateStatus: jest.fn(),
    };
    const service = new TransactionReversalService(transactionModel as any, false);

    const result = await service.reverse(transaction.id, "error");

    expect(result.notified).toBe(false);
    expect(mockedRoute).not.toHaveBeenCalled();
  });

  it("still performs the reversal when persistence is disabled", async () => {
    const transactionModel = {
      findById: jest
        .fn()
        .mockResolvedValueOnce(transaction)
        .mockResolvedValue({ ...transaction, status: TransactionStatus.Reversed }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const service = new TransactionReversalService(transactionModel as any, false);
    mockedRoute.mockResolvedValue(undefined);

    const result = await service.reverse(transaction.id, "error");

    expect(ledgerService.postReversal).toHaveBeenCalled();
    expect(result.record?.id).toBe("unpersisted");
    expect(mockedQueryWrite).not.toHaveBeenCalled();
  });
});

describe("retryNotification", () => {
  it("re-delivers for a posted-but-unnotified reversal", async () => {
    mockedRoute.mockResolvedValue(undefined);
    const transactionModel = {
      findById: jest.fn().mockResolvedValue(transaction),
      updateStatus: jest.fn(),
    };
    const service = new TransactionReversalService(transactionModel as any, true);
    mockedQueryRead.mockResolvedValue({
      rows: [reversalRow({ status: "posted", notified_at: null })],
    });

    const delivered = await service.retryNotification(reversalRow().id);

    expect(delivered).toBe(true);
    expect(mockedRoute).toHaveBeenCalled();
  });

  it("refuses to notify a reversal that never posted", async () => {
    const service = new TransactionReversalService({} as any, true);
    mockedQueryRead.mockResolvedValue({
      rows: [reversalRow({ status: "requested" })],
    });

    await expect(service.retryNotification(reversalRow().id)).resolves.toBe(false);
    expect(mockedRoute).not.toHaveBeenCalled();
  });
});

describe("getAuditTrail", () => {
  it("returns the ordered transition log", async () => {
    const service = new TransactionReversalService({} as any, true);
    mockedQueryRead.mockResolvedValue({
      rows: [
        {
          id: 1,
          reversal_id: reversalRow().id,
          from_status: null,
          to_status: "requested",
          actor_id: "admin-1",
          detail: { reason: "x" },
          created_at: new Date(),
        },
        {
          id: 2,
          reversal_id: reversalRow().id,
          from_status: "requested",
          to_status: "posted",
          actor_id: "admin-1",
          detail: {},
          created_at: new Date(),
        },
      ],
    });

    const trail = await service.getAuditTrail(reversalRow().id);

    expect(trail.map((e) => e.toStatus as ReversalStatus)).toEqual([
      "requested",
      "posted",
    ]);
  });
});

describe("listReversals", () => {
  it("returns newest-first history for a transaction", async () => {
    const service = new TransactionReversalService({} as any, true);
    mockedQueryRead.mockResolvedValue({
      rows: [reversalRow(), reversalRow({ id: "33333333-3333-3333-3333-333333333333" })],
    });

    const reversals = await service.listReversals(transaction.id);

    expect(reversals).toHaveLength(2);
    expect(reversals[0].originalReference).toBe("TXN-001");
  });
});
