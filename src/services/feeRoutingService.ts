import {
  MobileMoneyProvider,
  validateProviderLimits,
} from "../config/providers";
import { feeStrategyEngine, FeeCalculationResult } from "./feeStrategyEngine";

export interface ProviderFeeQuote {
  provider: MobileMoneyProvider;
  eligible: boolean;
  fee: number | null;
  total: number | null;
  savingsVsMostExpensive: number;
  strategyUsed?: string;
  reason?: string;
}

export interface FeeRoutingRecommendation {
  amount: number;
  recommendedProvider: MobileMoneyProvider | null;
  quotes: ProviderFeeQuote[];
}

const SUPPORTED_PROVIDERS: readonly MobileMoneyProvider[] = [
  MobileMoneyProvider.MTN,
  MobileMoneyProvider.AIRTEL,
  MobileMoneyProvider.ORANGE,
];

export function rankProviderQuotes(
  quotes: ProviderFeeQuote[],
): ProviderFeeQuote[] {
  const eligibleFees = quotes
    .filter((quote) => quote.eligible && quote.fee !== null)
    .map((quote) => quote.fee as number);
  const highestFee = eligibleFees.length > 0 ? Math.max(...eligibleFees) : 0;

  return quotes
    .map((quote) => ({
      ...quote,
      savingsVsMostExpensive:
        quote.fee === null ? 0 : roundCurrency(highestFee - quote.fee),
    }))
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if (left.fee === null && right.fee === null) return 0;
      if (left.fee === null) return 1;
      if (right.fee === null) return -1;
      return left.fee - right.fee;
    });
}

export async function compareProviderFees(
  amount: number,
  userId?: string,
  evaluationTime?: Date,
): Promise<FeeRoutingRecommendation> {
  const quotes = await Promise.all(
    SUPPORTED_PROVIDERS.map(async (provider) => {
      const limits = validateProviderLimits(provider, amount);
      if (!limits.valid) {
        return {
          provider,
          eligible: false,
          fee: null,
          total: null,
          savingsVsMostExpensive: 0,
          reason: limits.error,
        } satisfies ProviderFeeQuote;
      }

      const result: FeeCalculationResult = await feeStrategyEngine.calculateFee(
        {
          amount,
          userId,
          provider,
          evaluationTime,
        },
      );

      return {
        provider,
        eligible: true,
        fee: result.fee,
        total: result.total,
        savingsVsMostExpensive: 0,
        strategyUsed: result.strategyUsed,
      } satisfies ProviderFeeQuote;
    }),
  );

  const rankedQuotes = rankProviderQuotes(quotes).map((quote) => ({
    ...quote,
    total: quote.fee === null ? null : roundCurrency(amount + quote.fee),
  }));

  return {
    amount,
    recommendedProvider:
      rankedQuotes.find((quote) => quote.eligible)?.provider ?? null,
    quotes: rankedQuotes,
  };
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}
