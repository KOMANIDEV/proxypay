import {
  KYCLevel,
  TRANSACTION_LIMITS,
  MIN_TRANSACTION_AMOUNT,
  MAX_TRANSACTION_AMOUNT,
} from '../../config/limits';
import { getProviderLimits } from '../../config/providers';
import { KYCService } from '../kyc/kycService';
import { TransactionModel } from '../../models/transaction';

export interface LimitCheckResult {
  allowed: boolean;
  kycLevel: KYCLevel;
  dailyLimit: number;
  currentDailyTotal: number;
  remainingLimit: number;
  message?: string;
  upgradeAvailable?: boolean;
}

export class TransactionLimitService {
  constructor(
    private kycService: KYCService,
    private transactionModel: TransactionModel,
  ) {}

  async checkTransactionLimit(
    userId: string,
    transactionAmount: number,
    provider?: string,
  ): Promise<LimitCheckResult> {
    if (transactionAmount < MIN_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified,
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too small. Minimum allowed: ${MIN_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`,
      };
    }

    if (transactionAmount > MAX_TRANSACTION_AMOUNT) {
      return {
        allowed: false,
        kycLevel: KYCLevel.Unverified,
        dailyLimit: 0,
        currentDailyTotal: 0,
        remainingLimit: 0,
        message: `Transaction amount too large. Maximum allowed: ${MAX_TRANSACTION_AMOUNT} XAF. Attempted: ${transactionAmount} XAF.`,
      };
    }

    const kycLevel = await this.kycService.getUserKYCLevel(userId);
    const globalDailyLimit = TRANSACTION_LIMITS[kycLevel];

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTransactions = await this.transactionModel.findCompletedByUserSince(
      userId,
      twentyFourHoursAgo,
    );

    const currentDailyTotal = recentTransactions.reduce(
      (sum, tx) => sum + parseFloat(tx.amount),
      0,
    );

    const providerDailyLimit = this.getProviderDailyLimit(provider);
    const providerCurrentDailyTotal = this.getProviderDailyTotal(
      recentTransactions,
      provider,
    );
    const newProviderTotal = providerCurrentDailyTotal + transactionAmount;

    if (providerDailyLimit !== null && newProviderTotal > providerDailyLimit) {
      return {
        allowed: false,
        kycLevel,
        dailyLimit: providerDailyLimit,
        currentDailyTotal: providerCurrentDailyTotal,
        remainingLimit: Math.max(0, providerDailyLimit - providerCurrentDailyTotal),
        message: this.buildProviderErrorMessage(
          provider,
          providerDailyLimit,
          providerCurrentDailyTotal,
          transactionAmount,
        ),
        upgradeAvailable: kycLevel !== KYCLevel.Full,
      };
    }

    const newTotal = currentDailyTotal + transactionAmount;
    const remainingLimit = globalDailyLimit - currentDailyTotal;

    if (newTotal > globalDailyLimit) {
      return {
        allowed: false,
        kycLevel,
        dailyLimit: globalDailyLimit,
        currentDailyTotal,
        remainingLimit,
        message: this.buildErrorMessage(
          kycLevel,
          globalDailyLimit,
          currentDailyTotal,
          transactionAmount,
        ),
        upgradeAvailable: kycLevel !== KYCLevel.Full,
      };
    }

    return {
      allowed: true,
      kycLevel,
      dailyLimit: Math.min(globalDailyLimit, providerDailyLimit ?? globalDailyLimit),
      currentDailyTotal,
      remainingLimit: globalDailyLimit - newTotal,
    };
  }

  private getProviderDailyLimit(provider?: string): number | null {
    if (!provider) return null;
    const normalizedProvider = provider.toLowerCase();
    try {
      const limits = getProviderLimits(normalizedProvider as any);
      return limits.dailyLimit;
    } catch {
      return null;
    }
  }

  private getProviderDailyTotal(
    recentTransactions: Array<{ amount: string; provider?: string }>,
    provider?: string,
  ): number {
    if (!provider) return 0;
    const normalizedProvider = provider.toLowerCase();
    return recentTransactions.reduce((sum, tx) => {
      const txProvider = String(tx.provider ?? '').toLowerCase();
      return txProvider === normalizedProvider ? sum + parseFloat(tx.amount) : sum;
    }, 0);
  }

  private buildErrorMessage(
    kycLevel: KYCLevel,
    limit: number,
    current: number,
    attempted: number,
  ): string {
    let message = `Transaction limit exceeded. Your ${kycLevel} KYC level allows ${limit} XAF per day. `;
    message += `Current daily total: ${current} XAF. Attempted transaction: ${attempted} XAF.`;

    if (kycLevel === KYCLevel.Unverified) {
      message += ' Upgrade to Basic KYC for 100,000 XAF daily limit.';
    } else if (kycLevel === KYCLevel.Basic) {
      message += ' Upgrade to Full KYC for 1,000,000 XAF daily limit.';
    }

    return message;
  }

  private buildProviderErrorMessage(
    provider: string | undefined,
    limit: number,
    current: number,
    attempted: number,
  ): string {
    const providerName = provider ? provider.toUpperCase() : 'Provider';
    return `${providerName} daily limit exceeded. ${providerName} allows ${limit} XAF per day. Current provider total: ${current} XAF. Attempted transaction: ${attempted} XAF.`;
  }
}
