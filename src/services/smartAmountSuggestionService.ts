import logger from "../utils/logger";

export interface AmountHistoryEntry {
  userId: string;
  recipientId?: string;
  amount: number;
  currency: string;
  timestamp: Date;
}

export interface AmountSuggestionResult {
  frequentAmounts: number[];
  recommendedAmount: number;
  recentAmounts: number[];
  quickSelectBuckets: number[];
}

export class SmartAmountSuggestionService {
  private history: Map<string, AmountHistoryEntry[]> = new Map();

  /**
   * Track a transaction amount to build personalization heuristics.
   */
  public recordTransactionAmount(userId: string, amount: number, currency: string, recipientId?: string): void {
    const list = this.history.get(userId) || [];
    list.push({ userId, amount, currency, recipientId, timestamp: new Date() });
    if (list.length > 500) {
      list.shift();
    }
    this.history.set(userId, list);
  }

  /**
   * Calculate smart amount suggestions for a given user and recipient context.
   */
  public getSuggestions(userId: string, currency: string = "USD", recipientId?: string): AmountSuggestionResult {
    const userHistory = this.history.get(userId) || [];
    const filtered = userHistory.filter((e) => e.currency === currency && (!recipientId || e.recipientId === recipientId));

    if (filtered.length === 0) {
      // Default fallback tier for new users
      return {
        frequentAmounts: [10, 25, 50, 100],
        recommendedAmount: 25,
        recentAmounts: [],
        quickSelectBuckets: [10, 20, 50, 100, 200],
      };
    }

    // Count frequency
    const frequencyMap: Record<number, number> = {};
    for (const item of filtered) {
      frequencyMap[item.amount] = (frequencyMap[item.amount] || 0) + 1;
    }

    const sortedByFrequency = Object.entries(frequencyMap)
      .sort(([, a], [, b]) => b - a)
      .map(([amt]) => parseFloat(amt));

    const frequentAmounts = sortedByFrequency.slice(0, 4);

    // Recent amounts (unique, up to 3)
    const recentAmounts: number[] = [];
    for (let i = filtered.length - 1; i >= 0 && recentAmounts.length < 3; i--) {
      const amt = filtered[i].amount;
      if (!recentAmounts.includes(amt)) {
        recentAmounts.push(amt);
      }
    }

    // Recommended amount: most frequent or latest
    const recommendedAmount = frequentAmounts[0] || filtered[filtered.length - 1].amount;

    // Quick select dynamic round buckets based on average
    const avg = filtered.reduce((acc, e) => acc + e.amount, 0) / filtered.length;
    const baseRound = Math.pow(10, Math.floor(Math.log10(Math.max(avg, 10))));
    const quickSelectBuckets = [
      Math.round(baseRound * 0.5),
      Math.round(baseRound * 1.0),
      Math.round(baseRound * 2.0),
      Math.round(baseRound * 5.0),
    ].filter((v, idx, arr) => v > 0 && arr.indexOf(v) === idx);

    logger.info(`[SmartAmount] Generated suggestions for user ${userId}: recommended ${recommendedAmount} ${currency}`);

    return {
      frequentAmounts,
      recommendedAmount,
      recentAmounts,
      quickSelectBuckets,
    };
  }
}

export const smartAmountSuggestionService = new SmartAmountSuggestionService();
