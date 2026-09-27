import {
  MobileMoneyProvider,
  PROVIDER_LIMITS,
  validateDepositAmount,
} from "../providers";

describe("validateDepositAmount (#642)", () => {
  it("accepts a deposit within the provider limit", () => {
    const limits = PROVIDER_LIMITS[MobileMoneyProvider.MTN];
    const result = validateDepositAmount(
      MobileMoneyProvider.MTN,
      limits.maxAmount,
    );

    expect(result.valid).toBe(true);
    expect(result.provider).toBe("mtn");
    expect(result.limits).toEqual(limits);
    expect(result.error).toBeUndefined();
  });

  it("normalizes the provider casing", () => {
    const result = validateDepositAmount(
      "MTN",
      PROVIDER_LIMITS[MobileMoneyProvider.MTN].minAmount,
    );

    expect(result.valid).toBe(true);
    expect(result.provider).toBe("mtn");
  });

  it("rejects a deposit above the provider maximum", () => {
    const limits = PROVIDER_LIMITS[MobileMoneyProvider.MTN];
    const result = validateDepositAmount(
      MobileMoneyProvider.MTN,
      limits.maxAmount + 1,
    );

    expect(result.valid).toBe(false);
    expect(result.code).toBe("PROVIDER_MAX_AMOUNT");
    expect(result.error).toContain("MTN");
    expect(result.error).toContain(String(limits.maxAmount));
  });

  it("rejects a deposit below the provider minimum", () => {
    const limits = PROVIDER_LIMITS[MobileMoneyProvider.AIRTEL];
    const result = validateDepositAmount(
      MobileMoneyProvider.AIRTEL,
      limits.minAmount - 1,
    );

    expect(result.valid).toBe(false);
    expect(result.code).toBe("PROVIDER_MIN_AMOUNT");
  });

  it("returns provider-specific limits per provider", () => {
    const mtn = validateDepositAmount(
      MobileMoneyProvider.MTN,
      PROVIDER_LIMITS[MobileMoneyProvider.MTN].maxAmount + 1000,
    );
    const airtel = validateDepositAmount(
      MobileMoneyProvider.AIRTEL,
      PROVIDER_LIMITS[MobileMoneyProvider.AIRTEL].maxAmount + 1000,
    );

    expect(mtn.error).toContain("MTN");
    expect(mtn.error).toContain(
      String(PROVIDER_LIMITS[MobileMoneyProvider.MTN].maxAmount),
    );
    expect(airtel.error).toContain("AIRTEL");
    expect(airtel.error).toContain(
      String(PROVIDER_LIMITS[MobileMoneyProvider.AIRTEL].maxAmount),
    );
  });

  it("rejects unsupported providers", () => {
    const result = validateDepositAmount("wave", 1000);

    expect(result.valid).toBe(false);
    expect(result.code).toBe("UNKNOWN_PROVIDER");
    expect(result.error).toContain("wave");
  });

  it.each([0, -100, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-positive/non-finite deposit amounts (%s)",
    (amount) => {
      const result = validateDepositAmount(MobileMoneyProvider.MTN, amount);

      expect(result.valid).toBe(false);
      expect(result.code).toBe("INVALID_AMOUNT");
    },
  );
});
