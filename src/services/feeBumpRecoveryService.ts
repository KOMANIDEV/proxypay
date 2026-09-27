import { pool } from "../config/database";
import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";

// ─── Types ───────────────────────────────────────────────────────────────────

export type FeeBumpStatus =
  | "pending"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "failed"
  | "dead_letter";

export type FeeBumpFailureReason =
  | "network_error"
  | "sequence_number_mismatch"
  | "insufficient_balance"
  | "transaction_not_found"
  | "max_retries_exceeded"
  | "unknown";

export interface FeeBumpAttempt {
  id: string;
  transaction_id: string;
  original_hash: string;
  fee_bump_hash: string | null;
  status: FeeBumpStatus;
  attempt_number: number;
  max_retries: number;
  fee_amount: number;
  failure_reason: FeeBumpFailureReason | null;
  error_message: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeeBumpRecoveryStats {
  total: number;
  pending: number;
  confirmed: number;
  failed: number;
  dead_letter: number;
  success_rate: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_RETRIES = parseInt(process.env.FEE_BUMP_MAX_RETRIES || "5", 10);
const BASE_BACKOFF_MS = parseInt(process.env.FEE_BUMP_BASE_BACKOFF_MS || "5000", 10);
const MAX_BACKOFF_MS = parseInt(process.env.FEE_BUMP_MAX_BACKOFF_MS || "300000", 10);
const DEAD_LETTER_THRESHOLD = parseInt(process.env.FEE_BUMP_DEAD_LETTER_THRESHOLD || "10", 10);

// ─── State Machine ────────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<FeeBumpStatus, FeeBumpStatus[]> = {
  pending: ["submitting"],
  submitting: ["submitted", "failed"],
  submitted: ["confirmed", "failed"],
  confirmed: [],
  failed: ["submitting", "dead_letter"],
  dead_letter: ["submitting"],
};

function isValidTransition(from: FeeBumpStatus, to: FeeBumpStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Create Fee Bump Attempt ──────────────────────────────────────────────────

export async function createFeeBumpAttempt(params: {
  transactionId: string;
  originalHash: string;
  feeAmount: number;
  maxRetries?: number;
}): Promise<FeeBumpAttempt> {
  const id = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const maxRetries = params.maxRetries ?? MAX_RETRIES;

  await pool.query(
    `INSERT INTO fee_bump_attempts
      (id, transaction_id, original_hash, fee_bump_hash, status, attempt_number,
       max_retries, fee_amount, failure_reason, error_message, next_retry_at,
       created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
    [
      id,
      params.transactionId,
      params.originalHash,
      null,
      "pending",
      0,
      maxRetries,
      params.feeAmount,
      null,
      null,
      null,
    ],
  );

  return {
    id,
    transaction_id: params.transactionId,
    original_hash: params.originalHash,
    fee_bump_hash: null,
    status: "pending",
    attempt_number: 0,
    max_retries: maxRetries,
    fee_amount: params.feeAmount,
    failure_reason: null,
    error_message: null,
    next_retry_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ─── Submit Fee Bump with Retry ──────────────────────────────────────────────

export async function submitFeeBumpWithRetry(
  attemptId: string,
  originalTxXdr: string,
): Promise<FeeBumpAttempt> {
  const attempt = await getFeeBumpAttempt(attemptId);
  if (!attempt) throw new Error(`Fee bump attempt ${attemptId} not found`);

  const newAttemptNumber = attempt.attempt_number + 1;
  const server = getStellarServer();
  const networkPassphrase = getNetworkPassphrase();

  // Transition to submitting
  await updateFeeBumpStatus(attemptId, "submitting");

  try {
    const originalTx = new StellarSdk.Transaction(
      originalTxXdr,
      networkPassphrase,
    );

    const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
      originalTx,
      attempt.fee_amount.toString(),
      networkPassphrase,
    );

    const feeBumpXdr = feeBumpTx.toEnvelope().toXDR("base64");

    // Submit with timeout
    const result = await Promise.race([
      server.submitTransaction(feeBumpTx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Submission timeout")), 30000),
      ),
    ]);

    // Transition to submitted
    await pool.query(
      `UPDATE fee_bump_attempts
       SET status = 'submitted', attempt_number = $1, fee_bump_hash = $2, updated_at = NOW()
       WHERE id = $3`,
      [newAttemptNumber, (result as any).hash || null, attemptId],
    );

    // Check confirmation after delay
    setTimeout(async () => {
      try {
        const confirmed = await checkFeeBumpConfirmed(
          (result as any).hash || "",
        );
        if (confirmed) {
          await updateFeeBumpStatus(attemptId, "confirmed");
        } else {
          await scheduleRetry(attemptId, "transaction_not_found");
        }
      } catch {
        await scheduleRetry(attemptId, "network_error");
      }
    }, 15000);

    return {
      ...attempt,
      status: "submitted",
      attempt_number: newAttemptNumber,
      fee_bump_hash: (result as any).hash ?? null,
    };
  } catch (error: any) {
    const reason = classifyError(error);
    await handleFeeBumpFailure(attemptId, newAttemptNumber, reason, error.message);
    throw error;
  }
}

// ─── Failure Handling ─────────────────────────────────────────────────────────

async function handleFeeBumpFailure(
  attemptId: string,
  attemptNumber: number,
  reason: FeeBumpFailureReason,
  errorMessage: string,
): Promise<void> {
  const attempt = await getFeeBumpAttempt(attemptId);
  if (!attempt) return;

  if (reason === "sequence_number_mismatch" || reason === "insufficient_balance") {
    // Unrecoverable — send to dead letter
    await pool.query(
      `UPDATE fee_bump_attempts
       SET status = 'dead_letter', attempt_number = $1, failure_reason = $2,
           error_message = $3, updated_at = NOW()
       WHERE id = $4`,
      [attemptNumber, reason, errorMessage, attemptId],
    );

    await logDeadLetterEvent(attemptId, reason, errorMessage);
  } else if (attemptNumber >= attempt.max_retries) {
    // Max retries exceeded
    await pool.query(
      `UPDATE fee_bump_attempts
       SET status = 'dead_letter', attempt_number = $1, failure_reason = $2,
           error_message = $3, updated_at = NOW()
       WHERE id = $4`,
      [attemptNumber, "max_retries_exceeded", errorMessage, attemptId],
    );

    await logDeadLetterEvent(attemptId, "max_retries_exceeded", errorMessage);
  } else {
    // Schedule retry
    await scheduleRetry(attemptId, reason, errorMessage);
  }
}

async function scheduleRetry(
  attemptId: string,
  reason: FeeBumpFailureReason,
  errorMessage?: string,
): Promise<void> {
  const attempt = await getFeeBumpAttempt(attemptId);
  if (!attempt) return;

  const backoffMs = Math.min(
    BASE_BACKOFF_MS * Math.pow(2, attempt.attempt_number),
    MAX_BACKOFF_MS,
  );

  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();

  await pool.query(
    `UPDATE fee_bump_attempts
     SET status = 'failed', failure_reason = $1, error_message = $2,
         next_retry_at = $3, updated_at = NOW()
     WHERE id = $4`,
    [reason, errorMessage ?? null, nextRetryAt, attemptId],
  );
}

// ─── Manual Retry (Admin) ────────────────────────────────────────────────────

export async function manualRetryFeeBump(
  attemptId: string,
  originalTxXdr: string,
): Promise<FeeBumpAttempt> {
  const attempt = await getFeeBumpAttempt(attemptId);
  if (!attempt) throw new Error(`Fee bump attempt ${attemptId} not found`);

  if (attempt.status !== "dead_letter" && attempt.status !== "failed") {
    throw new Error(`Cannot retry attempt in status ${attempt.status}`);
  }

  await pool.query(
    `UPDATE fee_bump_attempts
     SET status = 'pending', failure_reason = NULL, error_message = NULL,
         next_retry_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [attemptId],
  );

  return submitFeeBumpWithRetry(attemptId, originalTxXdr);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyError(error: any): FeeBumpFailureReason {
  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("sequence")) return "sequence_number_mismatch";
  if (msg.includes("balance") || msg.includes("underfunded")) return "insufficient_balance";
  if (msg.includes("timeout") || msg.includes("network") || msg.includes("econnrefused")) return "network_error";
  if (msg.includes("not found")) return "transaction_not_found";
  return "unknown";
}

async function checkFeeBumpConfirmed(hash: string): Promise<boolean> {
  try {
    const server = getStellarServer();
    const result = await server
      .transactions()
      .transaction(hash)
      .call();
    return result.successful === true;
  } catch {
    return false;
  }
}

async function updateFeeBumpStatus(
  attemptId: string,
  status: FeeBumpStatus,
): Promise<void> {
  await pool.query(
    `UPDATE fee_bump_attempts SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, attemptId],
  );
}

async function logDeadLetterEvent(
  attemptId: string,
  reason: FeeBumpFailureReason,
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO fee_bump_dead_letter
      (attempt_id, failure_reason, error_message, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [attemptId, reason, errorMessage],
  );
}

export async function getFeeBumpAttempt(
  attemptId: string,
): Promise<FeeBumpAttempt | null> {
  const result = await pool.query(
    `SELECT * FROM fee_bump_attempts WHERE id = $1`,
    [attemptId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    original_hash: row.original_hash,
    fee_bump_hash: row.fee_bump_hash,
    status: row.status,
    attempt_number: row.attempt_number,
    max_retries: row.max_retries,
    fee_amount: parseFloat(row.fee_amount),
    failure_reason: row.failure_reason,
    error_message: row.error_message,
    next_retry_at: row.next_retry_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getFeeBumpRecoveryStats(): Promise<FeeBumpRecoveryStats> {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'pending' OR status = 'submitting' OR status = 'submitted')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter
    FROM fee_bump_attempts
  `);

  const row = result.rows[0];
  return {
    total: row.total,
    pending: row.pending,
    confirmed: row.confirmed,
    failed: row.failed,
    dead_letter: row.dead_letter,
    success_rate: row.total > 0 ? Math.round((row.confirmed / row.total) * 10000) / 100 : 0,
  };
}
