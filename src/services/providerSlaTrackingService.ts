import logger from "../utils/logger";

export interface ProviderSlaConfig {
  providerId: string;
  providerName: string;
  maxResponseTimeMs: number; // e.g., 2000ms
  availabilityTargetPercent: number; // e.g. 99.9%
  breachThresholdCount: number; // e.g. 3 consecutive breaches before alert
  alertWebhookUrl?: string;
  active: boolean;
}

export interface SlaMetricRecord {
  providerId: string;
  endpoint: string;
  responseTimeMs: number;
  statusCode: number;
  success: boolean;
  timestamp: Date;
}

export interface SlaViolation {
  id: string;
  providerId: string;
  violationType: "LATENCY_EXCEEDED" | "DOWNTIME_DETECTED" | "ERROR_RATE_SPIKE";
  measuredValue: number;
  targetValue: number;
  recordedAt: Date;
  notified: boolean;
}

export interface SlaPerformanceReport {
  providerId: string;
  totalRequests: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  slaBreachCount: number;
  availabilityPercent: number;
  slaMet: boolean;
  generatedAt: Date;
}

export class ProviderSlaTrackingService {
  private configs: Map<string, ProviderSlaConfig> = new Map();
  private metrics: SlaMetricRecord[] = [];
  private violations: SlaViolation[] = [];

  constructor() {
    // Default provider SLAs
    this.registerSlaConfig({
      providerId: "stellar-horizon",
      providerName: "Stellar Horizon Testnet/Pubnet",
      maxResponseTimeMs: 1500,
      availabilityTargetPercent: 99.9,
      breachThresholdCount: 3,
      active: true,
    });
    this.registerSlaConfig({
      providerId: "momo-mtn",
      providerName: "MTN Mobile Money Gateway",
      maxResponseTimeMs: 3000,
      availabilityTargetPercent: 99.5,
      breachThresholdCount: 2,
      active: true,
    });
  }

  public registerSlaConfig(config: ProviderSlaConfig): void {
    this.configs.set(config.providerId, config);
    logger.info(`[ProviderSLA] Configured SLA for provider ${config.providerId} (Max RT: ${config.maxResponseTimeMs}ms)`);
  }

  public getSlaConfig(providerId: string): ProviderSlaConfig | undefined {
    return this.configs.get(providerId);
  }

  public recordMetric(metric: Omit<SlaMetricRecord, "timestamp">): SlaViolation | null {
    const timestamp = new Date();
    const fullMetric: SlaMetricRecord = { ...metric, timestamp };
    this.metrics.push(fullMetric);

    // Keep metrics bound to last 10,000 entries
    if (this.metrics.length > 10000) {
      this.metrics.shift();
    }

    const config = this.configs.get(metric.providerId);
    if (!config || !config.active) return null;

    // Check response time latency SLA
    if (metric.responseTimeMs > config.maxResponseTimeMs) {
      const violation: SlaViolation = {
        id: `sla-viol-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        providerId: metric.providerId,
        violationType: "LATENCY_EXCEEDED",
        measuredValue: metric.responseTimeMs,
        targetValue: config.maxResponseTimeMs,
        recordedAt: timestamp,
        notified: false,
      };

      this.violations.push(violation);
      this.dispatchSlaBreachAlert(violation, config);
      return violation;
    }

    return null;
  }

  private dispatchSlaBreachAlert(violation: SlaViolation, config: ProviderSlaConfig): void {
    logger.error(
      `[ProviderSLA BREACH ALERT] Provider ${config.providerName} (${violation.providerId}) breached SLA! ` +
      `Measured: ${violation.measuredValue}ms, Limit: ${violation.targetValue}ms`
    );
    violation.notified = true;
  }

  public generatePerformanceReport(providerId: string): SlaPerformanceReport {
    const providerMetrics = this.metrics.filter((m) => m.providerId === providerId);
    const config = this.configs.get(providerId);

    if (providerMetrics.length === 0) {
      return {
        providerId,
        totalRequests: 0,
        avgResponseTimeMs: 0,
        p95ResponseTimeMs: 0,
        slaBreachCount: 0,
        availabilityPercent: 100,
        slaMet: true,
        generatedAt: new Date(),
      };
    }

    const totalRequests = providerMetrics.length;
    const successfulRequests = providerMetrics.filter((m) => m.success).length;
    const availabilityPercent = (successfulRequests / totalRequests) * 100;

    const responseTimes = providerMetrics.map((m) => m.responseTimeMs).sort((a, b) => a - b);
    const avgResponseTimeMs = responseTimes.reduce((acc, val) => acc + val, 0) / totalRequests;
    const p95Index = Math.min(Math.floor(totalRequests * 0.95), totalRequests - 1);
    const p95ResponseTimeMs = responseTimes[p95Index];

    const targetMax = config ? config.maxResponseTimeMs : 2000;
    const targetAvailability = config ? config.availabilityTargetPercent : 99.0;
    const slaBreachCount = providerMetrics.filter((m) => m.responseTimeMs > targetMax).length;

    const slaMet = p95ResponseTimeMs <= targetMax && availabilityPercent >= targetAvailability;

    return {
      providerId,
      totalRequests,
      avgResponseTimeMs: Math.round(avgResponseTimeMs * 100) / 100,
      p95ResponseTimeMs,
      slaBreachCount,
      availabilityPercent: Math.round(availabilityPercent * 100) / 100,
      slaMet,
      generatedAt: new Date(),
    };
  }

  public listViolations(providerId?: string): SlaViolation[] {
    if (providerId) {
      return this.violations.filter((v) => v.providerId === providerId);
    }
    return [...this.violations];
  }
}

export const providerSlaTrackingService = new ProviderSlaTrackingService();
