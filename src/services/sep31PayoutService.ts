import { pool } from "../config/database";
import { MobileMoneyService } from "./mobilemoney/mobileMoneyService";
import { TransactionModel } from "../models/transaction";
import { Sep31Status, isValidTransition } from "../stellar/sep31";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PayoutStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "retrying"
  | "dead_letter";

export interface PayoutAttempt {
  id: string;
  transaction_id: string;
  provider: string;
  receiver_account: string;
  amount: number;
  status: PayoutStatus;
  attempt_number: number;
  max_retries: number;
  error_message: string | null;
  payout_reference: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_RETRIES = parseInt(process.env.PAYOUT_MAX_RETRIES || "3", 10);
const BASE_BACKOFF_MS = parseInt(process.env.PAYOUT_BASE_BACKOFF_MS || "10000", 10);
const MAX_BACKOFF_MS = parseInt(process.env.PAYOUT_MAX_BACKOFF_MS || "600000", 10);

// ─── Provider-Specific Routing ────────────────────────────────────────────────

interface ProviderConfig {
  name: string;
  minAmount: number;
  maxAmount: number;
  feePercent: number;
  supportedCountries: string[];
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  mtn: {
    name: "MTN Mobile Money",
    minAmount: 1,
    maxAmount: 5000,
    feePercent: 0.01,
    supportedCountries: ["GH", "UG", "CM", "CI", "ZM", "RW"],
  },
  airtel: {
    name: "Airtel Money",
    minAmount: 1,
    maxAmount: 3000,
    feePercent: 0.015,
    supportedCountries: ["GH", "KE", "UG", "TZ", "RW", "ZM"],
  },
  orange: {
    name: "Orange Money",
    minAmount: 1,
    maxAmount: 2000,
    feePercent: 0.01,
    supportedCountries: ["GH", "CI", "SN", "ML", "CM"],
  },
  vodacom: {
    name: "Vodacom M-Pesa",
    minAmount: 1,
    maxAmount: 4000,
    feePercent: 0.012,
    supportedCountries: ["TZ", "KE", "CD", "MZ"],
  },
  tigo: {
    name: "Tigo Pesa",
    minAmount: 1,
    maxAmount: 2000,
    feePercent: 0.01,
    supportedCountries: ["TZ", "GH"],
  },
};

// ─── Main Payout Processing ──────────────────────────────────────────────────

export async function processSep31PayoutWithRetry(params: {
  transactionId: string;
  receiverAccount: string;
  amount: number;
  provider: string;
  mobileMoneyService: MobileMoneyService;
  transactionModel: TransactionModel;
}): Promise<PayoutAttempt> {
  const attempt = await createPayoutAttempt(params);

  return executePayout(attempt, params);
}

async function executePayout(
  attempt: PayoutAttempt,
  params: {
    transactionId: string;
    receiverAccount: string;
    amount: number;
    provider: string;
    mobileMoneyService: MobileMoneyService;
    transactionModel: TransactionModel;
  },
): Promise<PayoutAttempt> {
  const newAttemptNumber = attempt.attempt_number + 1;

  await updatePayoutStatus(attempt.id, "processing");

  try {
    const providerConfig = PROVIDER_CONFIGS[params.provider];
    if (!providerConfig) {
      throw new Error(`Unknown provider: ${params.provider}`);
    }

    // Validate amount
    if (params.amount < providerConfig.minAmount) {
      throw new Error(`Amount ${params.amount} below minimum ${providerConfig.minAmount} for ${params.provider}`);
    }
    if (params.amount > providerConfig.maxAmount) {
      throw new Error(`Amount ${params.amount} above maximum ${providerConfig.maxAmount} for ${params.provider}`);
    }

    const payoutResult = await params.mobileMoneyService.sendPayout(
      params.provider,
      params.receiverAccount,
      params.amount,
    );

    if (payoutResult.success) {
      await pool.query(
        `UPDATE payout_attempts
         SET status = 'completed', attempt_number = $1, payout_reference = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [
          newAttemptNumber,
          payoutResult.data?.reference || payoutResult.data?.transactionId || null,
          attempt.id,
        ],
      );

      return {
        ...attempt,
        status: "completed",
        attempt_number: newAttemptNumber,
        payout_reference: payoutResult.data?.reference || null,
      };
    } else {
      throw new Error(payoutResult.error || "Payout failed");
    }
  } catch (error: any) {
    const errorMessage = error?.message || "Unknown error";

    if (newAttemptNumber >= attempt.max_retries) {
      await pool.query(
        `UPDATE payout_attempts
         SET status = 'dead_letter', attempt_number = $1, error_message = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [newAttemptNumber, errorMessage, attempt.id],
      );

      // Log to dead letter queue
      await pool.query(
        `INSERT INTO payout_dead_letter
          (attempt_id, error_message, created_at)
         VALUES ($1, $2, NOW())`,
        [attempt.id, errorMessage],
      );

      return {
        ...attempt,
        status: "dead_letter",
        attempt_number: newAttemptNumber,
        error_message: errorMessage,
      };
    }

    // Schedule retry with exponential backoff
    const backoffMs = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, attempt.attempt_number),
      MAX_BACKOFF_MS,
    );
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();

    await pool.query(
      `UPDATE payout_attempts
       SET status = 'retrying', attempt_number = $1, error_message = $2,
           next_retry_at = $3, updated_at = NOW()
       WHERE id = $4`,
      [newAttemptNumber, errorMessage, nextRetryAt, attempt.id],
    );

    return {
      ...attempt,
      status: "retrying",
      attempt_number: newAttemptNumber,
      error_message: errorMessage,
      next_retry_at: nextRetryAt,
    };
  }
}

// ─── Retry Job ────────────────────────────────────────────────────────────────

export async function runPayoutRetryJob(
  mobileMoneyService: MobileMoneyService,
  transactionModel: TransactionModel,
): Promise<{ retried: number; failed: number }> {
  const now = new Date().toISOString();

  const result = await pool.query(
    `SELECT * FROM payout_attempts
     WHERE status = 'retrying'
       AND next_retry_at <= $1
     ORDER BY next_retry_at ASC
     LIMIT 50`,
    [now],
  );

  let retried = 0;
  let failed = 0;

  for (const row of result.rows) {
    try {
      await executePayout(
        {
          id: row.id,
          transaction_id: row.transaction_id,
          provider: row.provider,
          receiver_account: row.receiver_account,
          amount: parseFloat(row.amount),
          status: row.status,
          attempt_number: row.attempt_number,
          max_retries: row.max_retries,
          error_message: row.error_message,
          payout_reference: row.payout_reference,
          next_retry_at: row.next_retry_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
        {
          transactionId: row.transaction_id,
          receiverAccount: row.receiver_account,
          amount: parseFloat(row.amount),
          provider: row.provider,
          mobileMoneyService,
          transactionModel,
        },
      );
      retried++;
    } catch (error) {
      console.error(`[payout-retry] Failed retry for ${row.id}:`, error);
      failed++;
    }
  }

  return { retried, failed };
}

// ─── Database Helpers ─────────────────────────────────────────────────────────

async function createPayoutAttempt(params: {
  transactionId: string;
  receiverAccount: string;
  amount: number;
  provider: string;
}): Promise<PayoutAttempt> {
  const id = `payout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO payout_attempts
      (id, transaction_id, provider, receiver_account, amount, status,
       attempt_number, max_retries, error_message, payout_reference,
       next_retry_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      params.transactionId,
      params.provider,
      params.receiverAccount,
      params.amount,
      "pending",
      0,
      MAX_RETRIES,
      null,
      null,
      null,
      now,
      now,
    ],
  );

  return {
    id,
    transaction_id: params.transactionId,
    provider: params.provider,
    receiver_account: params.receiverAccount,
    amount: params.amount,
    status: "pending",
    attempt_number: 0,
    max_retries: MAX_RETRIES,
    error_message: null,
    payout_reference: null,
    next_retry_at: null,
    created_at: now,
    updated_at: now,
  };
}

async function updatePayoutStatus(
  attemptId: string,
  status: PayoutStatus,
): Promise<void> {
  await pool.query(
    `UPDATE payout_attempts SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, attemptId],
  );
}
