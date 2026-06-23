import {
  MobileMoneyProvider,
  getProviderLimits,
  validateProviderLimits,
  PROVIDER_LIMITS,
  DEFAULT_PROVIDER_LIMITS,
} from "../../src/config/providers";

describe("Provider Limits Configuration", () => {
  describe("Default Values", () => {
    it("should have correct default limits for MTN", () => {
      const limits = getProviderLimits(MobileMoneyProvider.MTN);
      expect(limits.minAmount).toBe(100);
      expect(limits.maxAmount).toBe(500000);
    });

    it("should have correct default limits for Airtel", () => {
      const limits = getProviderLimits(MobileMoneyProvider.AIRTEL);
      expect(limits.minAmount).toBe(100);
      expect(limits.maxAmount).toBe(1000000);
    });

    it("should have correct default limits for Orange", () => {
      const limits = getProviderLimits(MobileMoneyProvider.ORANGE);
      expect(limits.minAmount).toBe(500);
      expect(limits.maxAmount).toBe(750000);
    });
  });

  describe("PROVIDER_LIMITS export", () => {
    it("should export limits for all providers", () => {
      expect(PROVIDER_LIMITS).toHaveProperty(MobileMoneyProvider.MTN);
      expect(PROVIDER_LIMITS).toHaveProperty(MobileMoneyProvider.AIRTEL);
      expect(PROVIDER_LIMITS).toHaveProperty(MobileMoneyProvider.ORANGE);
    });

    it("should have valid min and max amounts for all providers", () => {
      const providers = [
        MobileMoneyProvider.MTN,
        MobileMoneyProvider.AIRTEL,
        MobileMoneyProvider.ORANGE,
      ];

      for (const provider of providers) {
        const limits = PROVIDER_LIMITS[provider];
        expect(limits.minAmount).toBeGreaterThan(0);
        expect(limits.maxAmount).toBeGreaterThan(0);
        expect(limits.minAmount).toBeLessThanOrEqual(limits.maxAmount);
        expect(isFinite(limits.minAmount)).toBe(true);
        expect(isFinite(limits.maxAmount)).toBe(true);
      }
    });
  });

  describe("getProviderLimits", () => {
    it("should return correct limits for each provider", () => {
      expect(getProviderLimits(MobileMoneyProvider.MTN)).toEqual(
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.MTN],
      );
      expect(getProviderLimits(MobileMoneyProvider.AIRTEL)).toEqual(
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.AIRTEL],
      );
      expect(getProviderLimits(MobileMoneyProvider.ORANGE)).toEqual(
        DEFAULT_PROVIDER_LIMITS[MobileMoneyProvider.ORANGE],
      );
    });

    it("should throw error for unknown provider", () => {
      expect(() => getProviderLimits("unknown" as MobileMoneyProvider)).toThrow(
        "Unknown provider",
      );
    });
  });
});

describe("Provider Limits Validation", () => {
  describe("MTN validation", () => {
    it("should accept amount within MTN limits (100 - 500,000)", () => {
      expect(validateProviderLimits(MobileMoneyProvider.MTN, 100).valid).toBe(
        true,
      );
      expect(
        validateProviderLimits(MobileMoneyProvider.MTN, 500000).valid,
      ).toBe(true);
      expect(
        validateProviderLimits(MobileMoneyProvider.MTN, 250000).valid,
      ).toBe(true);
    });

    it("should reject amount below MTN minimum (100)", () => {
      const result = validateProviderLimits(MobileMoneyProvider.MTN, 50);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("below the minimum");
      expect(result.error).toContain("MTN");
    });

    it("should reject amount above MTN maximum (500,000)", () => {
      const result = validateProviderLimits(MobileMoneyProvider.MTN, 500001);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds the maximum");
      expect(result.error).toContain("MTN");
    });
  });

  describe("Airtel validation", () => {
    it("should accept amount within Airtel limits (100 - 1,000,000)", () => {
      expect(
        validateProviderLimits(MobileMoneyProvider.AIRTEL, 100).valid,
      ).toBe(true);
      expect(
        validateProviderLimits(MobileMoneyProvider.AIRTEL, 1000000).valid,
      ).toBe(true);
      expect(
        validateProviderLimits(MobileMoneyProvider.AIRTEL, 500000).valid,
      ).toBe(true);
    });

    it("should reject amount below Airtel minimum (100)", () => {
      const result = validateProviderLimits(MobileMoneyProvider.AIRTEL, 50);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("below the minimum");
      expect(result.error).toContain("AIRTEL");
    });

    it("should reject amount above Airtel maximum (1,000,000)", () => {
      const result = validateProviderLimits(
        MobileMoneyProvider.AIRTEL,
        1000001,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds the maximum");
      expect(result.error).toContain("AIRTEL");
    });
  });

  describe("Orange validation", () => {
    it("should accept amount within Orange limits (500 - 750,000)", () => {
      expect(
        validateProviderLimits(MobileMoneyProvider.ORANGE, 500).valid,
      ).toBe(true);
      expect(
        validateProviderLimits(MobileMoneyProvider.ORANGE, 750000).valid,
      ).toBe(true);
      expect(
        validateProviderLimits(MobileMoneyProvider.ORANGE, 375000).valid,
      ).toBe(true);
    });

    it("should reject amount below Orange minimum (500)", () => {
      const result = validateProviderLimits(MobileMoneyProvider.ORANGE, 100);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("below the minimum");
      expect(result.error).toContain("ORANGE");
    });

    it("should reject amount above Orange maximum (750,000)", () => {
      const result = validateProviderLimits(MobileMoneyProvider.ORANGE, 750001);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds the maximum");
      expect(result.error).toContain("ORANGE");
    });
  });

  describe("Error messages", () => {
    it("should include allowed range in error message for below minimum", () => {
      const result = validateProviderLimits(MobileMoneyProvider.MTN, 50);
      expect(result.error).toContain("100 - 500000");
    });

    it("should include allowed range in error message for above maximum", () => {
      const result = validateProviderLimits(MobileMoneyProvider.MTN, 500001);
      expect(result.error).toContain("100 - 500000");
    });
  });
});
