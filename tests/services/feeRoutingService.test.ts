import { MobileMoneyProvider } from "../../src/config/providers";
import { feeStrategyEngine } from "../../src/services/feeStrategyEngine";
import {
  compareProviderFees,
  rankProviderQuotes,
} from "../../src/services/feeRoutingService";

describe("rankProviderQuotes", () => {
  it("ranks eligible providers by lowest fee and reports savings", () => {
    const quotes = rankProviderQuotes([
      {
        provider: MobileMoneyProvider.MTN,
        eligible: true,
        fee: 150,
        total: 10150,
        savingsVsMostExpensive: 0,
      },
      {
        provider: MobileMoneyProvider.AIRTEL,
        eligible: true,
        fee: 100,
        total: 10100,
        savingsVsMostExpensive: 0,
      },
      {
        provider: MobileMoneyProvider.ORANGE,
        eligible: true,
        fee: 125,
        total: 10125,
        savingsVsMostExpensive: 0,
      },
    ]);

    expect(quotes.map((quote) => quote.provider)).toEqual([
      MobileMoneyProvider.AIRTEL,
      MobileMoneyProvider.ORANGE,
      MobileMoneyProvider.MTN,
    ]);
    expect(quotes[0].savingsVsMostExpensive).toBe(50);
  });

  it("places ineligible providers after eligible providers", () => {
    const quotes = rankProviderQuotes([
      {
        provider: MobileMoneyProvider.ORANGE,
        eligible: false,
        fee: null,
        total: null,
        savingsVsMostExpensive: 0,
        reason: "out of range",
      },
      {
        provider: MobileMoneyProvider.MTN,
        eligible: true,
        fee: 100,
        total: 10100,
        savingsVsMostExpensive: 0,
      },
    ]);

    expect(quotes[0].provider).toBe(MobileMoneyProvider.MTN);
    expect(quotes[1].reason).toBe("out of range");
  });
});

describe("compareProviderFees", () => {
  it("recommends the cheapest eligible provider", async () => {
    jest
      .spyOn(feeStrategyEngine, "calculateFee")
      .mockImplementation(async (context) => ({
        fee: context.provider === MobileMoneyProvider.AIRTEL ? 80 : 120,
        total:
          context.amount +
          (context.provider === MobileMoneyProvider.AIRTEL ? 80 : 120),
        strategyUsed: `${context.provider} strategy`,
        scopeUsed: "provider",
        timeOverrideActive: false,
        breakdown: {
          strategyId: "strategy-id",
          strategyType: "percentage",
          rawFee: 120,
          clampedFee: 120,
        },
      }));

    const result = await compareProviderFees(1000);

    expect(result.recommendedProvider).toBe(MobileMoneyProvider.AIRTEL);
    expect(result.quotes[0].fee).toBe(80);
    expect(result.quotes[0].total).toBe(1080);
  });
});
