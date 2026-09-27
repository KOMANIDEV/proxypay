import { TransactionLimitService } from "./transactionLimitService";

describe("TransactionLimitService", () => {
  it("rejects transactions when the provider-specific daily limit is exceeded", async () => {
    const service = new TransactionLimitService(
      {
        getUserKYCLevel: jest.fn().mockResolvedValue("full"),
      } as any,
      {
        findCompletedByUserSince: jest.fn().mockResolvedValue([
          { amount: "150000", provider: "mtn" },
          { amount: "200000", provider: "mtn" },
        ]),
      } as any,
    );

    const result = await service.checkTransactionLimit("user-1", 200000, "mtn");

    expect(result.allowed).toBe(false);
    expect(result.message).toContain("MTN daily limit");
    expect(result.dailyLimit).toBeLessThanOrEqual(500000);
  });
});
