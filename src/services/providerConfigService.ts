import logger from "../utils/logger";

export interface ProviderConfiguration {
  providerId: string;
  version: number;
  apiEndpoint: string;
  timeoutMs: number;
  rateLimitPerMinute: number;
  supportedCurrencies: string[];
  featuresEnabled: {
    instantSettlement: boolean;
    webhooks: boolean;
    reconciliation: boolean;
  };
  updatedAt: Date;
}

export class ProviderConfigService {
  private configs: Map<string, ProviderConfiguration> = new Map();
  private history: Map<string, ProviderConfiguration[]> = new Map();

  constructor() {
    // Initialize default configurations
    const defaults: ProviderConfiguration[] = [
      {
        providerId: "mtn",
        version: 1,
        apiEndpoint: "https://api.mtn.com/v1/payments",
        timeoutMs: 15000,
        rateLimitPerMinute: 300,
        supportedCurrencies: ["XLM", "UGX", "GHS"],
        featuresEnabled: { instantSettlement: true, webhooks: true, reconciliation: true },
        updatedAt: new Date(),
      },
      {
        providerId: "airtel",
        version: 1,
        apiEndpoint: "https://api.airtel.com/v1/openapi",
        timeoutMs: 12000,
        rateLimitPerMinute: 250,
        supportedCurrencies: ["XLM", "KES", "RWF"],
        featuresEnabled: { instantSettlement: true, webhooks: true, reconciliation: true },
        updatedAt: new Date(),
      },
    ];

    for (const c of defaults) {
      this.configs.set(c.providerId, c);
      this.history.set(c.providerId, [{ ...c }]);
    }
  }

  /**
   * Discover and fetch latest configuration from provider discovery endpoint
   */
  async discoverAndFetchConfig(providerId: string): Promise<Partial<ProviderConfiguration>> {
    logger.info({ providerId }, "Discovering provider configuration updates");
    // Mock discovery response
    return {
      timeoutMs: 10000,
      rateLimitPerMinute: 400,
    };
  }

  /**
   * Validate proposed configuration changes
   */
  validateConfig(config: Partial<ProviderConfiguration>): void {
    if (config.timeoutMs !== undefined && config.timeoutMs < 1000) {
      throw new Error("timeoutMs must be at least 1000ms");
    }
    if (config.rateLimitPerMinute !== undefined && config.rateLimitPerMinute <= 0) {
      throw new Error("rateLimitPerMinute must be positive");
    }
    if (config.apiEndpoint && !config.apiEndpoint.startsWith("https://")) {
      throw new Error("apiEndpoint must be secure (https)");
    }
  }

  /**
   * Automatically update provider configuration
   */
  async updateProviderConfig(
    providerId: string,
    updates: Partial<ProviderConfiguration>
  ): Promise<ProviderConfiguration> {
    this.validateConfig(updates);
    const existing = this.configs.get(providerId);
    if (!existing) {
      throw new Error(`Provider configuration for '${providerId}' not found`);
    }

    const nextVersion = existing.version + 1;
    const newConfig: ProviderConfiguration = {
      ...existing,
      ...updates,
      providerId,
      version: nextVersion,
      updatedAt: new Date(),
    };

    // Store in history for rollback support
    const hist = this.history.get(providerId) || [];
    hist.push({ ...newConfig });
    this.history.set(providerId, hist);

    this.configs.set(providerId, newConfig);
    logger.info({ providerId, version: nextVersion }, "Provider configuration updated successfully");
    return newConfig;
  }

  /**
   * Rollback provider configuration to previous version
   */
  async rollbackConfig(providerId: string, targetVersion?: number): Promise<ProviderConfiguration> {
    const hist = this.history.get(providerId);
    if (!hist || hist.length <= 1) {
      throw new Error(`Cannot rollback provider '${providerId}': no previous configuration versions available`);
    }

    let previous: ProviderConfiguration | undefined;
    if (targetVersion) {
      previous = hist.find((c) => c.version === targetVersion);
    } else {
      // Find the second-to-last config
      previous = hist[hist.length - 2];
    }

    if (!previous) {
      throw new Error(`Target rollback version not found for provider '${providerId}'`);
    }

    const restored: ProviderConfiguration = {
      ...previous,
      version: (this.configs.get(providerId)?.version || 1) + 1,
      updatedAt: new Date(),
    };

    this.configs.set(providerId, restored);
    hist.push({ ...restored });

    logger.warn({ providerId, rolledBackToVersion: previous.version }, "Rolled back provider configuration");
    return restored;
  }

  /**
   * Get current provider configuration
   */
  getConfig(providerId: string): ProviderConfiguration | undefined {
    return this.configs.get(providerId);
  }
}

export const providerConfigService = new ProviderConfigService();
