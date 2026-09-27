import { TransactionStatus } from "../../models/transaction";
import { ledgerService } from "../ledgerService";
import { TransactionReversalService } from "../transactionReversalService";

describe("TransactionReversalService", () => {
  const transaction = {
    id: "transaction-1",
    referenceNumber: "TXN-001",
    status: TransactionStatus.Failed,
  } as any;

  let transactionModel: {
    findById: jest.Mock;
    updateStatus: jest.Mock;
  };
  let reversalService: TransactionReversalService;

  beforeEach(() => {
    transactionModel = {
      findById: jest
        .fn()
        .mockResolvedValueOnce(transaction)
        .mockResolvedValueOnce({ ...transaction, status: TransactionStatus.Reversed }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    // The second argument disables durable reversal tracking so this suite
    // exercises only the ledger behaviour; persistence is covered by
    // transactionReversalState.test.ts.
    reversalService = new TransactionReversalService(transactionModel as any, false);
    jest.spyOn(ledgerService, "postReversal").mockResolvedValue({
      alreadyReversed: false,
      entries: [],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("posts a compensating ledger entry and reverses a failed transaction", async () => {
    const result = await reversalService.reverse(
      transaction.id,
      "Provider marked payment failed",
      "admin-1",
    );

    expect(ledgerService.postReversal).toHaveBeenCalledWith(
      transaction.id,
      transaction.referenceNumber,
      "Provider marked payment failed",
      "admin-1",
    );
    expect(transactionModel.updateStatus).toHaveBeenCalledWith(
      transaction.id,
      TransactionStatus.Reversed,
    );
    expect(result.transaction?.status).toBe(TransactionStatus.Reversed);
  });

  it("does not reverse an ineligible transaction", async () => {
    transactionModel.findById.mockReset();
    transactionModel.findById.mockResolvedValue({
      ...transaction,
      status: TransactionStatus.Pending,
    });

    await expect(
      reversalService.reverse(transaction.id, "too early"),
    ).rejects.toThrow("Cannot reverse transaction in status: pending");
    expect(ledgerService.postReversal).not.toHaveBeenCalled();
  });

  it("does not post or update status when the transaction is already reversed", async () => {
    transactionModel.findById.mockReset();
    transactionModel.findById.mockResolvedValue({
      ...transaction,
      status: TransactionStatus.Reversed,
    });

    const result = await reversalService.reverse(transaction.id, "retry");

    expect(result.reversal.alreadyReversed).toBe(true);
    expect(ledgerService.postReversal).not.toHaveBeenCalled();
    expect(transactionModel.updateStatus).not.toHaveBeenCalled();
  });

  it("finishes the status update when the ledger reversal already exists", async () => {
    ledgerService.postReversal.mockResolvedValue({
      alreadyReversed: true,
      entries: [],
    });

    await reversalService.reverse(transaction.id, "retry after commit");

    expect(transactionModel.updateStatus).toHaveBeenCalledWith(
      transaction.id,
      TransactionStatus.Reversed,
    );
  });
});