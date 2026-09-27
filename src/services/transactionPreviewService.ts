/**
 * Transaction preview service.
 *
 * Lets users preview a deposit/withdrawal **before** submitting it, so they
 * can confirm the amount, estimated fees and total before money moves.
 *
 * A preview never persists anything — no transaction row, no job, no ledger
 * entry. It simulates the submission pipeline and reports:
 *
 *   - input validation results (phone/network match, provider amount limits)
 *   - the user's remaining daily limit for this amount
 *   - an estimated fee (VIP-tier aware) and estimated total
 *   - a trustline check for withdrawals (the most common submit-time failure)
 *   - an estimated settlement time
 *
 * Failures are collected as `checks` with `valid: false` rather than thrown,
 * so the client can surface *all* reasons a transaction cannot proceed.
 * Unexpected infrastructure errors still propagate to the caller.
 */

import { validatePhoneProviderMatch } from "../utils/phoneUtils";
import {
  MobileMoneyProvider,
  validateProviderLimits,
} from "../config/providers";
import { TransactionModel } from "../models/transaction";
import { KYCService } from "./kyc/kycService";
import { TransactionLimitService } from "./transactionLimit/transactionLimitService";
import {
  checkDestinationTrustline,
  TrustlineError,
} from "../stellar/trustlines";
import { getConfiguredPaymentAsset } from "./stellar/assetService";
import {
  calculateFeeForUser,
  calculateFee,
  FeeResult,
  VipFeeResult,
} from "../utils/fees";

export type PreviewTransactionType = "deposit" | "withdraw";

export interface TransactionPreviewInput {
  type: PreviewTransactionType;
  amount: number;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  userId: string;
}

export interface PreviewCheck {
  /** Stable check identifier (e.g. `network_match`, `daily_limit`). */
  name: string;
  passed: boolean;
  /** Human-readable detail when the check fails. */
  details?: string;
}

export interface DailyLimitPreview {
  kycLevel: string;
  dailyLimit: number;
  currentDailyTotal: number;
  remainingLimit: number;
  allowed: boolean;
}

export interface TransactionPreviewResult {
  status: "preview";
  valid: boolean;
  type: PreviewTransactionType;
  amount: number;
  currency: string;
  provider: string;
  /** Estimated provider + platform fee for this amount. */
  estimatedFee: number;
  /** amount + estimatedFee. */
  estimatedTotal: number;
  estimatedSettlementTime: string;
  feeDetails?: {
    tier?: string;
    discountPercent?: number;
    configUsed?: string;
  };
  dailyLimit?: DailyLimitPreview;
  checks: PreviewCheck[];
  warnings: string[];
  /** Always true for previews — nothing was submitted. */
  simulated: boolean;
}

export class PreviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewValidationError";
  }
}

const SETTLEMENT_TIME_ESTIMATES: Record<PreviewTransactionType, string> = {
  deposit: "30–120 seconds (provider confirmation + Stellar settlement)",
  withdraw: "15–60 seconds (Stellar settlement + provider disbursement)",
};

const PREVIEW_CURRENCY = process.env.PREVIEW_CURRENCY ?? "XAF";

export interface TransactionPreviewDependencies {
  transactionModel?: TransactionModel;
  kycService?: KYCService;
  transactionLimitService?: TransactionLimitService;
  /** Override the fee calculator (injected for tests). */
  calculateFeeForUserFn?: (
    amount: number,
    userId: string,
  ) => Promise<VipFeeResult>;
  calculateFeeFn?: (amount: number) => Promise<FeeResult>;
  checkTrustlineFn?: (
    destination: string,
    asset: unknown,
  ) => Promise<void>;
}

function toFeeNumber(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

export class TransactionPreviewService {
  private readonly transactionModel: TransactionModel;
  private readonly kycService: KYCService;
  private readonly limitService: TransactionLimitService;
  private readonly calculateFeeForUserFn: TransactionPreviewDependencies["calculateFeeForUserFn"];
  private readonly calculateFeeFn: TransactionPreviewDependencies["calculateFeeFn"];
  private readonly checkTrustlineFn: TransactionPreviewDependencies["checkTrustlineFn"];

  constructor(dependencies: TransactionPreviewDependencies = {}) {
    this.transactionModel =
      dependencies.transactionModel ?? new TransactionModel();
    this.kycService = dependencies.kycService ?? new KYCService();
    this.limitService =
      dependencies.transactionLimitService ??
      new TransactionLimitService(this.kycService, this.transactionModel);
    this.calculateFeeForUserFn =
      dependencies.calculateFeeForUserFn ?? calculateFeeForUser;
    this.calculateFeeFn = dependencies.calculateFeeFn ?? calculateFee;
    this.checkTrustlineFn =
      dependencies.checkTrustlineFn ?? checkDestinationTrustline;
  }

  /**
   * Simulate a transaction submission and return a full preview.
   *
   * No records are created. All validation outcomes are reported through the
   * returned `checks` array; the top-level `valid` flag is true only when
   * every check passed.
   *
   * @throws {PreviewValidationError} for structurally invalid input (e.g.
   *   non-finite amount).
   */
  async previewTransaction(
    input: TransactionPreviewInput,
  ): Promise<TransactionPreviewResult> {
    const { type, amount, phoneNumber, provider, stellarAddress, userId } =
      input;

    const requestAmount = Number(amount);
    if (!Number.isFinite(requestAmount) || requestAmount <= 0) {
      throw new PreviewValidationError(
        "Amount must be a positive number",
      );
    }

    const normalizedProvider = String(provider).toLowerCase();
    const checks: PreviewCheck[] = [];
    const warnings: string[] = [];

    // 1. Phone number ↔ provider network match
    const networkMatch = validatePhoneProviderMatch(
      phoneNumber,
      normalizedProvider,
    );
    checks.push({
      name: "network_match",
      passed: networkMatch.valid,
      details: networkMatch.valid ? undefined : networkMatch.error,
    });
    if (!networkMatch.valid) {
      warnings.push(`Phone number does not match the ${normalizedProvider} network`);
    }

    // 2. Provider amount limits
    const providerLimitCheck = validateProviderLimits(
      normalizedProvider as MobileMoneyProvider,
      requestAmount,
    );
    checks.push({
      name: "provider_limit",
      passed: providerLimitCheck.valid,
      details: providerLimitCheck.valid ? undefined : providerLimitCheck.error,
    });
    if (!providerLimitCheck.valid) {
      warnings.push("Amount outside the provider's allowed range");
    }

    // 3. Daily limit for this user
    let dailyLimit: DailyLimitPreview | undefined;
    try {
      const limitCheck = await this.limitService.checkTransactionLimit(
        userId,
        requestAmount,
        normalizedProvider,
      );
      dailyLimit = {
        kycLevel: limitCheck.kycLevel,
        dailyLimit: limitCheck.dailyLimit,
        currentDailyTotal: limitCheck.currentDailyTotal,
        remainingLimit: limitCheck.remainingLimit,
        allowed: limitCheck.allowed,
      };
      checks.push({
        name: "daily_limit",
        passed: limitCheck.allowed,
        details: limitCheck.allowed ? undefined : limitCheck.message,
      });
      if (!limitCheck.allowed) {
        warnings.push(limitCheck.message ?? "Daily transaction limit exceeded");
      }
    } catch {
      // Limit checks should never block a preview — report as a warning.
      warnings.push("Unable to verify daily limit at this time");
    }

    // 4. Fee estimation (VIP tier aware, falls back to base fee)
    let estimatedFee = 0;
    let feeDetails: TransactionPreviewResult["feeDetails"];
    try {
      const feeResult = await this.calculateFeeForUserFn(
        requestAmount,
        userId,
      );
      estimatedFee = toFeeNumber(feeResult.fee);
      feeDetails = {
        tier: feeResult.tier,
        discountPercent: feeResult.discountPercent,
        configUsed: feeResult.configUsed,
      };
    } catch {
      try {
        const feeResult = await this.calculateFeeFn(requestAmount);
        estimatedFee = toFeeNumber(feeResult.fee);
        feeDetails = { configUsed: feeResult.configUsed };
      } catch {
        warnings.push("Unable to estimate fees at this time");
      }
    }

    // 5. Trustline check for withdrawals (non-fatal — informational)
    if (type === "withdraw") {
      try {
        const paymentAsset = getConfiguredPaymentAsset();
        await this.checkTrustlineFn(stellarAddress, paymentAsset);
        checks.push({ name: "destination_trustline", passed: true });
      } catch (error) {
        const message =
          error instanceof TrustlineError
            ? error.message
            : "Unable to verify destination trustline at this time";
        checks.push({
          name: "destination_trustline",
          passed: false,
          details: message,
        });
        warnings.push(message);
      }
    }

    const valid = checks.every((check) => check.passed);

    return {
      status: "preview",
      valid,
      type,
      amount: requestAmount,
      currency: PREVIEW_CURRENCY,
      provider: normalizedProvider,
      estimatedFee,
      estimatedTotal: toFeeNumber(requestAmount + estimatedFee),
      estimatedSettlementTime: SETTLEMENT_TIME_ESTIMATES[type],
      feeDetails,
      dailyLimit,
      checks,
      warnings,
      simulated: true,
    };
  }
}

export const transactionPreviewService = new TransactionPreviewService();
