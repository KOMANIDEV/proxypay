import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
import {
  providerFailoverAlerts,
  providerFailoverTotal,
  transactionErrorsTotal,
  transactionTotal,
} from "../../utils/metrics";
import logger from "../../utils/logger";
import { enqueueProviderCall } from "./providerThrottle";

export type ProviderTransactionStatus =
  | "completed"
  | "failed"
  | "pending"
  | "unknown";

export interface BatchPayoutItem {
  referenceId: string;
  phoneNumber: string;
  amount: string;
}

export interface BatchPayoutResult {
  referenceId: string;
  success: boolean;
  error?: string;
  providerReference?: string;
}

export interface MobileMoneyProvider {
  requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  sendBatchPayout?(
    provider: string,
    items: BatchPayoutItem[],
  ): Promise<{
    success: boolean;
    results: BatchPayoutResult[];
    error?: unknown;
  }>;
  getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }>;
}

// The source TypeScript implementation is currently unavailable in this clone,
// but the compiled CommonJS artifact is committed and used throughout the app.
// Re-export it here so TypeScript consumers can continue importing the module.
 
const { MobileMoneyService: BaseMobileMoneyService } = require("./mobileMoneyService_impl.js");

const THROTTLED_PROVIDERS = new Set(["mtn", "airtel"]);

class ThrottledMobileMoneyService extends BaseMobileMoneyService {
  private readonly hasInjectedProviders: boolean;

  constructor(providers?: Map<string, MobileMoneyProvider>) {
    super(providers);
    this.hasInjectedProviders = Boolean(providers);
  }

  private shouldThrottle(provider: string): boolean {
    return (
      !this.hasInjectedProviders &&
      process.env.NODE_ENV !== "test" &&
      THROTTLED_PROVIDERS.has(provider.toLowerCase())
    );
  }

  initiatePayment(provider: string, phoneNumber: string, amount: string) {
    if (!this.shouldThrottle(provider)) {
      return super.initiatePayment(provider, phoneNumber, amount);
    }
    return enqueueProviderCall({ operation: "payment", provider, phoneNumber, amount });
  }

  sendPayout(provider: string, phoneNumber: string, amount: string) {
    if (!this.shouldThrottle(provider)) {
      return super.sendPayout(provider, phoneNumber, amount);
    }
    return enqueueProviderCall({ operation: "payout", provider, phoneNumber, amount });
  }

  sendBatchPayout(provider: string, items: BatchPayoutItem[]) {
    if (!this.shouldThrottle(provider)) {
      return super.sendBatchPayout(provider, items);
    }
    return enqueueProviderCall({ operation: "batchPayout", provider, items });
  }
}

export { ThrottledMobileMoneyService as MobileMoneyService };
