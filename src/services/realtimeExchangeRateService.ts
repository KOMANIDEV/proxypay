import logger from "../utils/logger";
import { CurrencyCode } from "../models/historicalPrice";

export interface RateSubscription {
  id: string;
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  callback: (rateUpdate: RealtimeRateUpdate) => void;
}

export interface RealtimeRateUpdate {
  pair: string;
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number;
  change24hPercent: number;
  volatilityFlag: boolean;
  timestamp: Date;
}

export interface VolatilityAlert {
  id: string;
  pair: string;
  previousRate: number;
  newRate: number;
  percentChange: number;
  thresholdPercent: number;
  triggeredAt: Date;
}

export class RealtimeExchangeRateService {
  private cache: Map<string, RealtimeRateUpdate> = new Map();
  private history: Map<string, Array<{ rate: number; timestamp: Date }>> = new Map();
  private subscribers: Map<string, RateSubscription[]> = new Map();
  private volatilityThresholdPercent: number = 5.0; // Alert if change >= 5%

  constructor() {
    // Seed initial rates
    this.updateRate("XLM", "USD", 0.125);
    this.updateRate("USD", "XAF", 605.5);
    this.updateRate("XLM", "XAF", 75.68);
  }

  public getPairKey(base: CurrencyCode, quote: CurrencyCode): string {
    return `${base}_${quote}`.toUpperCase();
  }

  /**
   * Subscribe to real-time rate updates for a currency pair
   */
  public subscribe(base: CurrencyCode, quote: CurrencyCode, callback: (update: RealtimeRateUpdate) => void): RateSubscription {
    const pair = this.getPairKey(base, quote);
    const sub: RateSubscription = {
      id: `sub-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      baseCurrency: base,
      quoteCurrency: quote,
      callback,
    };

    const subs = this.subscribers.get(pair) || [];
    subs.push(sub);
    this.subscribers.set(pair, subs);

    // Immediately push cached rate if available
    const cached = this.cache.get(pair);
    if (cached) {
      callback(cached);
    }

    return sub;
  }

  /**
   * Unsubscribe from rate updates
   */
  public unsubscribe(sub: RateSubscription): void {
    const pair = this.getPairKey(sub.baseCurrency, sub.quoteCurrency);
    const subs = this.subscribers.get(pair) || [];
    this.subscribers.set(
      pair,
      subs.filter((s) => s.id !== sub.id)
    );
  }

  /**
   * Ingest a new rate update, perform volatility detection, update cache, and notify subscribers
   */
  public updateRate(base: CurrencyCode, quote: CurrencyCode, rate: number): { update: RealtimeRateUpdate; alert: VolatilityAlert | null } {
    const pair = this.getPairKey(base, quote);
    const timestamp = new Date();

    const pairHistory = this.history.get(pair) || [];
    const previousRate = pairHistory.length > 0 ? pairHistory[pairHistory.length - 1].rate : rate;

    // Record historical tracking point
    pairHistory.push({ rate, timestamp });
    if (pairHistory.length > 1440) { // Limit to 24h of minute-interval history
      pairHistory.shift();
    }
    this.history.set(pair, pairHistory);

    // Calculate volatility and percentage change
    const percentChange = previousRate === 0 ? 0 : ((rate - previousRate) / previousRate) * 100;
    const isVolatile = Math.abs(percentChange) >= this.volatilityThresholdPercent;

    let alert: VolatilityAlert | null = null;
    if (isVolatile && pairHistory.length > 1) {
      alert = {
        id: `vol-${Date.now()}`,
        pair,
        previousRate,
        newRate: rate,
        percentChange: Math.round(percentChange * 100) / 100,
        thresholdPercent: this.volatilityThresholdPercent,
        triggeredAt: timestamp,
      };
      logger.warn(
        `[RealtimeRate VOLATILITY] ${pair} shifted by ${alert.percentChange}% (from ${previousRate} to ${rate})`
      );
    }

    const update: RealtimeRateUpdate = {
      pair,
      base,
      quote,
      rate,
      change24hPercent: Math.round(percentChange * 100) / 100,
      volatilityFlag: isVolatile,
      timestamp,
    };

    // Store in cache
    this.cache.set(pair, update);

    // Notify active subscribers
    const subs = this.subscribers.get(pair) || [];
    for (const sub of subs) {
      try {
        sub.callback(update);
      } catch (e: any) {
        logger.error(`[RealtimeRate] Callback failed for sub ${sub.id}: ${e.message}`);
      }
    }

    return { update, alert };
  }

  /**
   * Retrieve cached rate for a given pair
   */
  public getCachedRate(base: CurrencyCode, quote: CurrencyCode): RealtimeRateUpdate | undefined {
    return this.cache.get(this.getPairKey(base, quote));
  }

  /**
   * Retrieve historical rate points
   */
  public getHistoricalRates(base: CurrencyCode, quote: CurrencyCode, limit: number = 60): Array<{ rate: number; timestamp: Date }> {
    const pair = this.getPairKey(base, quote);
    const history = this.history.get(pair) || [];
    return history.slice(-limit);
  }
}

export const realtimeExchangeRateService = new RealtimeExchangeRateService();
