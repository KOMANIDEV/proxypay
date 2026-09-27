import {
  createSep6Transaction,
  getSep6Transaction,
  updateSep6TransactionStatus,
} from "../../src/services/sep6Service";
import { pool } from "../../src/config/database";

jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

const mockPool = pool as jest.Mocked<typeof pool>;

describe("SEP-6 Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createSep6Transaction", () => {
    it("creates a deposit transaction", async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      const tx = await createSep6Transaction({
        kind: "deposit",
        account: "GABC...",
        assetCode: "USDC",
        memo: "test-memo",
        memoType: "text",
      });

      expect(tx.kind).toBe("deposit");
      expect(tx.status).toBe("pending_user_transfer_start");
      expect(tx.asset_code).toBe("USDC");
      expect(tx.account).toBe("GABC...");
      expect(tx.memo).toBe("test-memo");
    });

    it("creates a withdrawal transaction", async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      const tx = await createSep6Transaction({
        kind: "withdrawal",
        account: "GDEF...",
        assetCode: "USDC",
      });

      expect(tx.kind).toBe("withdrawal");
    });
  });

  describe("getSep6Transaction", () => {
    it("returns null for non-existent transaction", async () => {
      mockPool.query.mockResolvedValue({ rows: [] } as any);

      const result = await getSep6Transaction("nonexistent");
      expect(result).toBeNull();
    });

    it("returns transaction data when found", async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            id: "sep6_test",
            kind: "deposit",
            status: "pending_user_transfer_start",
            account: "GABC...",
            memo: null,
            memo_type: null,
            asset_code: "USDC",
            amount_in: null,
            amount_out: null,
            fee_fixed: null,
            fee_percent: null,
            started_at: new Date().toISOString(),
            completed_at: null,
            stellar_transaction_id: null,
            external_transaction_id: null,
            claimable_balance_id: null,
          },
        ],
      } as any);

      const result = await getSep6Transaction("sep6_test");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("sep6_test");
    });
  });

  describe("updateSep6TransactionStatus", () => {
    it("updates status successfully", async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      await updateSep6TransactionStatus("sep6_test", "pending_transfer");

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sep6_transactions"),
        ["sep6_test", "pending_transfer"],
      );
    });
  });
});
