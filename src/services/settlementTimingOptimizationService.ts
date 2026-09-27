import logger from "../utils/logger";

export type SettlementScheduleType = "IMMEDIATE" | "HOURLY" | "END_OF_DAY" | "NEXT_DAY" | "DYNAMIC_OPTIMIZED";

export interface MerchantSettlementConfig {
  merchantId: string;
  scheduleType: SettlementScheduleType;
  cutoffHourUtc?: number; // e.g., 22 for 22:00 UTC
  minimumSettlementThreshold: number; // e.g. minimum $100 before releasing batch
  autoOptimize: boolean;
  updatedAt: Date;
}

export interface SettlementPatternAnalysis {
  merchantId: string;
  peakVolumeHoursUtc: number[];
  averageTicketSize: number;
  dailyTransactionCount: number;
  liquidityVolatilityRisk: "LOW" | "MEDIUM" | "HIGH";
  suggestedSchedule: SettlementScheduleType;
  expectedFeeSavingsPercent: number;
  expectedCashFlowImprovementDays: number;
  analyzedAt: Date;
}

export class SettlementTimingOptimizationService {
  private configs: Map<string, MerchantSettlementConfig> = new Map();

  constructor() {
    // Seed default configuration
    this.configs.set("default", {
      merchantId: "default",
      scheduleType: "END_OF_DAY",
      cutoffHourUtc: 23,
      minimumSettlementThreshold: 50.0,
      autoOptimize: false,
      updatedAt: new Date(),
    });
  }

  /**
   * Set or update merchant settlement configuration
   */
  public setMerchantConfig(config: MerchantSettlementConfig): void {
    this.configs.set(config.merchantId, config);
    logger.info(`[SettlementOptimization] Updated settlement config for merchant ${config.merchantId} to ${config.scheduleType}`);
  }

  public getMerchantConfig(merchantId: string): MerchantSettlementConfig {
    return this.configs.get(merchantId) || {
      merchantId,
      scheduleType: "END_OF_DAY",
      cutoffHourUtc: 23,
      minimumSettlementThreshold: 50.0,
      autoOptimize: false,
      updatedAt: new Date(),
    };
  }

  /**
   * Analyze transaction patterns to detect optimal settlement windows and reduce gas/processing fees.
   */
  public analyzeSettlementPatterns(
    merchantId: string,
    historicalTxHours: number[],
    amounts: number[]
  ): SettlementPatternAnalysis {
    const dailyCount = amounts.length;
    const avgTicket = dailyCount > 0 ? amounts.reduce((a, b) => a + b, 0) / dailyCount : 0;

    // Detect frequency of transaction hours
    const hourCounts: Record<number, number> = {};
    for (const h of historicalTxHours) {
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    }

    const sortedHours = Object.entries(hourCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([h]) => parseInt(h, 10));

    const peakVolumeHours = sortedHours.slice(0, 3);

    // Dynamic schedule recommendation based on volume and ticket sizes
    let suggestedSchedule: SettlementScheduleType = "END_OF_DAY";
    let feeSavings = 5.0;
    let cashFlowImprovement = 0.5;
    let risk: "LOW" | "MEDIUM" | "HIGH" = "LOW";

    if (dailyCount > 500 && avgTicket > 1000) {
      suggestedSchedule = "DYNAMIC_OPTIMIZED";
      feeSavings = 14.5;
      cashFlowImprovement = 1.5;
      risk = "MEDIUM";
    } else if (dailyCount > 100) {
      suggestedSchedule = "HOURLY";
      feeSavings = 8.0;
      cashFlowImprovement = 1.0;
    }

    const analysis: SettlementPatternAnalysis = {
      merchantId,
      peakVolumeHoursUtc: peakVolumeHours,
      averageTicketSize: Math.round(avgTicket * 100) / 100,
      dailyTransactionCount: dailyCount,
      liquidityVolatilityRisk: risk,
      suggestedSchedule,
      expectedFeeSavingsPercent: feeSavings,
      expectedCashFlowImprovementDays: cashFlowImprovement,
      analyzedAt: new Date(),
    };

    logger.info(`[SettlementOptimization] Analyzed merchant ${merchantId}: suggested ${suggestedSchedule} with ${feeSavings}% fee savings`);
    return analysis;
  }
}

export const settlementTimingOptimizationService = new SettlementTimingOptimizationService();
