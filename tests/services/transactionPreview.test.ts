import {
  TransactionPreviewService,
  PreviewValidationError,
} from "../../src/services/transactionPreviewService";
import { TrustlineError } from "../../src/stellar/trustlines";

const VALID_INPUT = {
  type: "deposit" as const,
  amount: 2500,
  phoneNumber: "+237670000000", // MTN Cameroon prefix
  provider: "mtn",
  stellarAddress: "G" + "A".repeat(55),
  userId: "user-123",
};

function makeService(overrides: {
  limitCheck?: any;
  feeResult?: any;
  trustlineError?: Error;
  feeThrows?: boolean;
  limitThrows?: boolean;
} = {}) {
  const {
    limitCheck = { allowed: true, kycLevel: "basic", dailyLimit: 100000, currentDailyTotal: 1000, remainingLimit: 99000 },
    feeResult = { fee: 37.5, total: 2537.5, tier: "BRONZE", discountPercent: 0, thirtyDayVolume: 0, configUsed: "default" },
    trustlineError,
    feeThrows = false,
    limitThrows = false,
  } = overrides;

  const transactionLimitService = {
    checkTransactionLimit: jest.fn(async () => {
      if (limitThrows) throw new Error("db down");
      return limitCheck;
    }),
  } as any;

  const service = new TransactionPreviewService({
    transactionLimitService,
    calculateFeeForUserFn: jest.fn(async () => {
      if (feeThrows) throw new Error("fee db down");
      return feeResult;
    }),
    calculateFeeFn: jest.fn(async () => ({ fee: 40, total: 2540, configUsed: "env_fallback" })),
    checkTrustlineFn: jest.fn(async () => {
      if (trustlineError) throw trustlineError;
    }),
  });

  return { service, transactionLimitService };
}

describe("TransactionPreviewService", () => {
  it("returns a valid preview with estimated fees for a deposit", async () => {
    const { service } = makeService();
    const preview = await service.previewTransaction(VALID_INPUT);

    expect(preview.status).toBe("preview");
    expect(preview.simulated).toBe(true);
    expect(preview.valid).toBe(true);
    expect(preview.type).toBe("deposit");
    expect(preview.amount).toBe(2500);
    expect(preview.estimatedFee).toBe(37.5);
    expect(preview.estimatedTotal).toBe(2537.5);
    expect(preview.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["network_match", "provider_limit", "daily_limit"]),
    );
    expect(preview.checks.every((c) => c.passed)).toBe(true);
    expect(preview.warnings).toEqual([]);
  });

  it("reports a network mismatch as an invalid check with a warning", async () => {
    const { service } = makeService();
    const preview = await service.previewTransaction({
      ...VALID_INPUT,
      phoneNumber: "+254712345678", // Airtel Kenya prefix, not MTN
    });

    expect(preview.valid).toBe(false);
    const networkCheck = preview.checks.find((c) => c.name === "network_match");
    expect(networkCheck?.passed).toBe(false);
    expect(preview.warnings.length).toBeGreaterThan(0);
  });

  it("reports a provider amount limit violation", async () => {
    const { service } = makeService();
    const preview = await service.previewTransaction({
      ...VALID_INPUT,
      amount: 1, // below MTN minimum (100)
    });

    expect(preview.valid).toBe(false);
    const limitCheck = preview.checks.find((c) => c.name === "provider_limit");
    expect(limitCheck?.passed).toBe(false);
    expect(limitCheck?.details).toMatch(/below the minimum/i);
  });

  it("reports the user's remaining daily limit and flags over-limit amounts", async () => {
    const { service } = makeService({
      limitCheck: { allowed: false, kycLevel: "unverified", dailyLimit: 10000, currentDailyTotal: 9500, remainingLimit: 500, message: "Daily limit exceeded" },
    });
    const preview = await service.previewTransaction(VALID_INPUT);

    expect(preview.valid).toBe(false);
    expect(preview.dailyLimit).toMatchObject({
      kycLevel: "unverified",
      remainingLimit: 500,
      allowed: false,
    });
    const dailyCheck = preview.checks.find((c) => c.name === "daily_limit");
    expect(dailyCheck?.passed).toBe(false);
  });

  it("does not fail the preview when the limit service is unavailable", async () => {
    const { service } = makeService({ limitThrows: true });
    const preview = await service.previewTransaction(VALID_INPUT);

    expect(preview.valid).toBe(true);
    expect(preview.warnings).toContain("Unable to verify daily limit at this time");
  });

  it("falls back to the base fee calculator when the VIP calculator fails", async () => {
    const { service } = makeService({ feeThrows: true });
    const preview = await service.previewTransaction(VALID_INPUT);

    expect(preview.estimatedFee).toBe(40);
    expect(preview.estimatedTotal).toBe(2540);
    expect(preview.feeDetails?.configUsed).toBe("env_fallback");
  });

  it("checks the destination trustline for withdrawals", async () => {
    const { service } = makeService();
    const preview = await service.previewTransaction({
      ...VALID_INPUT,
      type: "withdraw",
    });

    const trustlineCheck = preview.checks.find(
      (c) => c.name === "destination_trustline",
    );
    expect(trustlineCheck?.passed).toBe(true);
    expect(preview.valid).toBe(true);
  });

  it("surfaces a missing trustline as a warning without failing the preview", async () => {
    const { service } = makeService({
      trustlineError: new TrustlineError(
        "Destination account has no trustline for USDC",
        {} as any,
      ),
    });
    const preview = await service.previewTransaction({
      ...VALID_INPUT,
      type: "withdraw",
    });

    const trustlineCheck = preview.checks.find(
      (c) => c.name === "destination_trustline",
    );
    expect(trustlineCheck?.passed).toBe(false);
    expect(trustlineCheck?.details).toMatch(/no trustline/i);
    expect(preview.warnings.some((w) => w.includes("trustline"))).toBe(true);
  });

  it("throws PreviewValidationError for a non-positive amount", async () => {
    const { service } = makeService();
    await expect(
      service.previewTransaction({ ...VALID_INPUT, amount: 0 }),
    ).rejects.toThrow(PreviewValidationError);
    await expect(
      service.previewTransaction({ ...VALID_INPUT, amount: -50 }),
    ).rejects.toThrow(PreviewValidationError);
  });

  it("never creates transactions — only returns advisory data", async () => {
    const { service, transactionLimitService } = makeService();
    const preview = await service.previewTransaction(VALID_INPUT);

    expect(preview.status).toBe("preview");
    expect(preview.simulated).toBe(true);
    // The only collaborator touched is the read-only limit check.
    expect(transactionLimitService.checkTransactionLimit).toHaveBeenCalledTimes(1);
    expect(transactionLimitService.checkTransactionLimit).toHaveBeenCalledWith(
      "user-123",
      2500,
    );
  });
});
