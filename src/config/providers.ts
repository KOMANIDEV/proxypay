import { getConfigValue } from './appConfig';

export enum MobileMoneyProvider {
  MTN = "mtn",
  AIRTEL = "airtel",
  ORANGE = "orange",
}

export interface ProviderLimits {
  minAmount: number;
  maxAmount: number;
  dailyLimit: number;
}

export interface ProviderLimitsConfig {
  [MobileMoneyProvider.MTN]: ProviderLimits;
  [MobileMoneyProvider.AIRTEL]: ProviderLimits;
  [MobileMoneyProvider.ORANGE]: ProviderLimits;
}

/**
 * Get provider limits from centralized configuration.
 * This replaces hardcoded defaults with values from appConfig.
 */
export function getProviderLimitsConfig(): ProviderLimitsConfig {
  const providers = getConfigValue('providers');
  return {
    [MobileMoneyProvider.MTN]: {
      minAmount: providers.mtn.minAmount,
      maxAmount: providers.mtn.maxAmount,
      dailyLimit: providers.mtn.dailyLimit,
    },
    [MobileMoneyProvider.AIRTEL]: {
      minAmount: providers.airtel.minAmount,
      maxAmount: providers.airtel.maxAmount,
      dailyLimit: providers.airtel.dailyLimit,
    },
    [MobileMoneyProvider.ORANGE]: {
      minAmount: providers.orange.minAmount,
      maxAmount: providers.orange.maxAmount,
      dailyLimit: providers.orange.dailyLimit,
    },
  };
}

export const DEFAULT_PROVIDER_LIMITS: ProviderLimitsConfig = {
  [MobileMoneyProvider.MTN]: { minAmount: 100, maxAmount: 500000, dailyLimit: 500000 },
  [MobileMoneyProvider.AIRTEL]: { minAmount: 100, maxAmount: 1000000, dailyLimit: 1000000 },
  [MobileMoneyProvider.ORANGE]: { minAmount: 500, maxAmount: 750000, dailyLimit: 750000 },
};

// PROVIDER_LIMITS is now dynamically loaded from config
export const PROVIDER_LIMITS: ProviderLimitsConfig = getProviderLimitsConfig();

export function getProviderLimits(
  provider: MobileMoneyProvider,
): ProviderLimits {
  const limits = PROVIDER_LIMITS[provider];
  if (!limits) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return limits;
}

export function validateProviderLimits(
  provider: MobileMoneyProvider,
  amount: number,
): { valid: boolean; error?: string } {
  const limits = getProviderLimits(provider);

  if (amount < limits.minAmount) {
    return {
      valid: false,
      error: `Amount ${amount} XAF is below the minimum of ${limits.minAmount} XAF for ${provider.toUpperCase()}. Allowed range: ${limits.minAmount} - ${limits.maxAmount} XAF`,
    };
  }

  if (amount > limits.maxAmount) {
    return {
      valid: false,
      error: `Amount ${amount} XAF exceeds the maximum of ${limits.maxAmount} XAF for ${provider.toUpperCase()}. Allowed range: ${limits.minAmount} - ${limits.maxAmount} XAF`,
    };
  }

  return { valid: true };
}

export type DepositLimitErrorCode =
  | "PROVIDER_MIN_AMOUNT"
  | "PROVIDER_MAX_AMOUNT"
  | "UNKNOWN_PROVIDER"
  | "INVALID_AMOUNT";

export interface DepositAmountValidationResult {
  valid: boolean;
  provider: string;
  amount: number;
  limits?: ProviderLimits;
  code?: DepositLimitErrorCode;
  error?: string;
}

/**
 * Validate a deposit amount against the provider-specific per-transaction
 * limits loaded from configuration.
 *
 * Global and KYC-level limits are enforced separately by
 * `transactionLimitService`; this check only applies the destination
 * provider's own min/max (e.g. MTN vs Airtel) so a deposit outside the
 * provider's accepted range fails fast with a provider-specific message.
 */
export function validateDepositAmount(
  provider: MobileMoneyProvider | string,
  amount: number,
): DepositAmountValidationResult {
  const normalizedProvider = String(provider ?? "").toLowerCase();
  const limits = PROVIDER_LIMITS[normalizedProvider as MobileMoneyProvider];

  if (!limits) {
    return {
      valid: false,
      provider: normalizedProvider,
      amount,
      code: "UNKNOWN_PROVIDER",
      error: `Unsupported mobile money provider: ${provider}`,
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      valid: false,
      provider: normalizedProvider,
      amount,
      limits,
      code: "INVALID_AMOUNT",
      error: "Amount must be a positive number",
    };
  }

  if (amount < limits.minAmount) {
    return {
      valid: false,
      provider: normalizedProvider,
      amount,
      limits,
      code: "PROVIDER_MIN_AMOUNT",
      error: `${normalizedProvider.toUpperCase()} deposits must be at least ${limits.minAmount} XAF. You provided ${amount} XAF.`,
    };
  }

  if (amount > limits.maxAmount) {
    return {
      valid: false,
      provider: normalizedProvider,
      amount,
      limits,
      code: "PROVIDER_MAX_AMOUNT",
      error: `${normalizedProvider.toUpperCase()} deposits are limited to a maximum of ${limits.maxAmount} XAF per transaction. You provided ${amount} XAF.`,
    };
  }

  return {
    valid: true,
    provider: normalizedProvider,
    amount,
    limits,
  };
}

function validateLimitsConfig(): void {
  const providers = [
    MobileMoneyProvider.MTN,
    MobileMoneyProvider.AIRTEL,
    MobileMoneyProvider.ORANGE,
  ];

  for (const provider of providers) {
    const limits = PROVIDER_LIMITS[provider];

    if (limits.minAmount <= 0 || !isFinite(limits.minAmount)) {
      throw new Error(
        `Invalid min amount for ${provider}: ${limits.minAmount}`,
      );
    }
    if (limits.maxAmount <= 0 || !isFinite(limits.maxAmount)) {
      throw new Error(
        `Invalid max amount for ${provider}: ${limits.maxAmount}`,
      );
    }
    if (limits.dailyLimit <= 0 || !isFinite(limits.dailyLimit)) {
      throw new Error(
        `Invalid daily limit for ${provider}: ${limits.dailyLimit}`,
      );
    }
    if (limits.minAmount > limits.maxAmount) {
      throw new Error(`Min amount cannot exceed max amount for ${provider}`);
    }
    if (limits.maxAmount > limits.dailyLimit) {
      throw new Error(`Provider daily limit cannot be below max single amount for ${provider}`);
    }
  }
}

validateLimitsConfig();
