import * as StellarSdk from "stellar-sdk";
import { getNetworkPassphrase, getStellarServer } from "../config/stellar";
import { addAccountMergeJob, addBatchAccountMergeJobs } from "../queue/accountMergeQueue";
import { pool } from "../config/database";
import logger from "../utils/logger";

const ACCOUNT_MERGE_PREFIX = "[account-merge]";
const STROOPS_PER_XLM = 10_000_000n;
const BASE_FEE_STROOPS = BigInt(StellarSdk.BASE_FEE.toString());

export interface MergeSafetyCheckResult {
  eligible: boolean;
  hasActiveDisputes: boolean;
  hasPendingTransactions: boolean;
  requiresManualReview: boolean;
  activeDisputeCount: number;
  pendingTransactionCount: number;
  reasons: string[];
}

export interface AccountMergeCandidate {
  nativeBalance: string;
  subentryCount: number;
  hasNonNativeBalances: boolean;
  lastActivityAt: Date | null;
}

export interface AccountMergeEvaluation {
  eligible: boolean;
  reason?: string;
  reclaimableBalance: string;
}

export function parseAuxiliaryAccountSecrets(
  value: string | undefined = process.env.STELLAR_AUXILIARY_ACCOUNT_SECRETS,
): string[] {
  if (!value) return [];

  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function resolveMergeDestinationPublicKey(
  destination: string | undefined = process.env
    .STELLAR_ACCOUNT_MERGE_DESTINATION,
  issuerSecret: string | undefined = process.env.STELLAR_ISSUER_SECRET,
): string | null {
  if (destination?.trim()) {
    const publicKey = destination.trim();
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new Error(
        "STELLAR_ACCOUNT_MERGE_DESTINATION must be a valid Stellar public key",
      );
    }
    return publicKey;
  }

  if (!issuerSecret?.trim()) return null;

  return StellarSdk.Keypair.fromSecret(issuerSecret.trim()).publicKey();
}

export function xlmToStroops(amount: string): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(normalized)) {
    throw new Error(`Invalid XLM amount: ${amount}`);
  }

  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const paddedFraction = `${fractionalPart}0000000`.slice(0, 7);

  return BigInt(wholePart) * STROOPS_PER_XLM + BigInt(paddedFraction);
}

export function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Check if an account has active disputes that block merging.
 */
export async function checkActiveDisputes(
  stellarAddress: string,
): Promise<{ hasActiveDisputes: boolean; count: number }> {
  try {
    const res = await pool.query(
      `SELECT COUNT(*) FROM disputes d
       JOIN transactions t ON d.transaction_id = t.id
       WHERE t.stellar_address = $1
         AND d.status IN ('open', 'investigating')`,
      [stellarAddress],
    );
    const count = parseInt(res.rows[0].count, 10);
    return { hasActiveDisputes: count > 0, count };
  } catch (err) {
    logger.error({ error: err, stellarAddress }, "Failed to check active disputes");
    return { hasActiveDisputes: false, count: 0 };
  }
}

/**
 * Check if an account has pending transactions that block merging.
 */
export async function checkPendingTransactions(
  stellarAddress: string,
): Promise<{ hasPendingTransactions: boolean; count: number }> {
  try {
    const res = await pool.query(
      `SELECT COUNT(*) FROM transactions
       WHERE stellar_address = $1
         AND status IN ('pending', 'processing')`,
      [stellarAddress],
    );
    const count = parseInt(res.rows[0].count, 10);
    return { hasPendingTransactions: count > 0, count };
  } catch (err) {
    logger.error({ error: err, stellarAddress }, "Failed to check pending transactions");
    return { hasPendingTransactions: false, count: 0 };
  }
}

/**
 * Check if an account requires manual review before merging.
 * Manual review is required when:
 * - The account has recent disputes (resolved within last 7 days)
 * - The account has a balance above a configured threshold
 * - The account has been flagged for compliance review
 */
export async function checkManualReviewRequired(
  stellarAddress: string,
): Promise<{ requiresManualReview: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const MANUAL_REVIEW_THRESHOLD_XLM = parseFloat(
    process.env.ACCOUNT_MERGE_MANUAL_REVIEW_THRESHOLD || "100",
  );
  const REVIEW_LOOKBACK_DAYS = 7;

  try {
    const balanceCheck = await pool.query(
      `SELECT native_balance FROM account_merge_candidates
       WHERE stellar_address = $1`,
      [stellarAddress],
    );

    if (balanceCheck.rows[0]) {
      const balance = parseFloat(balanceCheck.rows[0].native_balance || "0");
      if (balance > MANUAL_REVIEW_THRESHOLD_XLM) {
        reasons.push(`Balance ${balance} XLM exceeds manual review threshold of ${MANUAL_REVIEW_THRESHOLD_XLM} XLM`);
      }
    }

    const recentDisputes = await pool.query(
      `SELECT COUNT(*) FROM disputes d
       JOIN transactions t ON d.transaction_id = t.id
       WHERE t.stellar_address = $1
         AND d.status IN ('resolved', 'reversed', 'upheld')
         AND d.updated_at >= NOW() - INTERVAL '1 day' * $2`,
      [stellarAddress, REVIEW_LOOKBACK_DAYS],
    );

    if (parseInt(recentDisputes.rows[0].count, 10) > 0) {
      reasons.push(`Has ${recentDisputes.rows[0].count} recently resolved disputes within last ${REVIEW_LOOKBACK_DAYS} days`);
    }

    const complianceFlag = await pool.query(
      `SELECT COUNT(*) FROM aml_alerts
       WHERE stellar_address = $1
         AND status IN ('open', 'investigating')`,
      [stellarAddress],
    );

    if (parseInt(complianceFlag.rows[0].count, 10) > 0) {
      reasons.push("Has active AML/compliance alerts");
    }
  } catch (err) {
    logger.error({ error: err, stellarAddress }, "Failed to check manual review requirements");
  }

  return { requiresManualReview: reasons.length > 0, reasons };
}

/**
 * Run all safety checks for a Stellar account before allowing merge.
 */
export async function runMergeSafetyChecks(
  stellarAddress: string,
): Promise<MergeSafetyCheckResult> {
  const [disputes, pending, manualReview] = await Promise.all([
    checkActiveDisputes(stellarAddress),
    checkPendingTransactions(stellarAddress),
    checkManualReviewRequired(stellarAddress),
  ]);

  const reasons: string[] = [];
  if (disputes.hasActiveDisputes) {
    reasons.push(`Has ${disputes.count} active dispute(s)`);
  }
  if (pending.hasPendingTransactions) {
    reasons.push(`Has ${pending.count} pending transaction(s)`);
  }
  if (manualReview.requiresManualReview) {
    reasons.push(...manualReview.reasons);
  }

  const eligible = !disputes.hasActiveDisputes && !pending.hasPendingTransactions && !manualReview.requiresManualReview;

  return {
    eligible,
    hasActiveDisputes: disputes.hasActiveDisputes,
    hasPendingTransactions: pending.hasPendingTransactions,
    requiresManualReview: manualReview.requiresManualReview,
    activeDisputeCount: disputes.count,
    pendingTransactionCount: pending.count,
    reasons,
  };
}

export function evaluateAccountMergeCandidate(
  candidate: AccountMergeCandidate,
  inactivityDays: number,
  now: Date = new Date(),
): AccountMergeEvaluation {
  const nativeBalanceStroops = xlmToStroops(candidate.nativeBalance);
  const reclaimableStroops = nativeBalanceStroops - BASE_FEE_STROOPS;
  const reclaimableBalance =
    reclaimableStroops > 0n ? stroopsToXlm(reclaimableStroops) : "0";

  if (nativeBalanceStroops <= BASE_FEE_STROOPS) {
    return {
      eligible: false,
      reason: "native balance is too low to reclaim after fees",
      reclaimableBalance,
    };
  }

  if (candidate.subentryCount > 0) {
    return {
      eligible: false,
      reason: `account still has ${candidate.subentryCount} subentries`,
      reclaimableBalance,
    };
  }

  if (candidate.hasNonNativeBalances) {
    return {
      eligible: false,
      reason: "account still holds non-native assets",
      reclaimableBalance,
    };
  }

  if (candidate.lastActivityAt) {
    const inactivityCutoff = new Date(now);
    inactivityCutoff.setDate(inactivityCutoff.getDate() - inactivityDays);

    if (candidate.lastActivityAt > inactivityCutoff) {
      return {
        eligible: false,
        reason: `account was active within the last ${inactivityDays} day(s)`,
        reclaimableBalance,
      };
    }
  }

  return {
    eligible: true,
    reclaimableBalance,
  };
}

function getNativeBalance(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): string {
  const nativeBalance = account.balances.find(
    (balance) => balance.asset_type === "native",
  );
  return nativeBalance?.balance ?? "0";
}

function hasNonNativeBalances(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): boolean {
  return account.balances.some(
    (balance) =>
      balance.asset_type !== "native" && Number.parseFloat(balance.balance) > 0,
  );
}

async function fetchLastActivityAt(
  server: StellarSdk.Horizon.Server,
  publicKey: string,
): Promise<Date | null> {
  const response = await server
    .transactions()
    .forAccount(publicKey)
    .order("desc")
    .limit(1)
    .call();

  const latestTransaction = response.records[0];
  return latestTransaction ? new Date(latestTransaction.created_at) : null;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeResponse = error as {
    response?: { status?: number };
  };

  return maybeResponse.response?.status === 404;
}

/**
 * Queue account merge jobs for all configured auxiliary accounts.
 * This function runs as a scheduled job and queues individual merge jobs to BullMQ.
 * Before queuing, safety checks are performed for each account to prevent
 * merging accounts with active disputes, pending transactions, or requiring manual review.
 */
export async function runAccountMergeJob(): Promise<void> {
  const sourceSecrets = parseAuxiliaryAccountSecrets();
  if (sourceSecrets.length === 0) {
    console.log(`${ACCOUNT_MERGE_PREFIX} No auxiliary accounts configured`);
    return;
  }

  const destination = resolveMergeDestinationPublicKey();
  if (!destination) {
    console.log(
      `${ACCOUNT_MERGE_PREFIX} No merge destination configured; skipping run`,
    );
    return;
  }

  const inactivityDays = Number.parseInt(
    process.env.ACCOUNT_MERGE_INACTIVITY_DAYS || "30",
    10,
  );
  const dryRun = process.env.ACCOUNT_MERGE_DRY_RUN === "true";
  const skipSafetyChecks = process.env.ACCOUNT_MERGE_SKIP_SAFETY_CHECKS === "true";

  console.log(
    `${ACCOUNT_MERGE_PREFIX} Queuing ${sourceSecrets.length} account merge jobs (dryRun=${dryRun}, skipSafetyChecks=${skipSafetyChecks})`,
  );

  const qualifiedJobs: Array<{
    sourceSecret: string;
    destinationPublicKey: string;
    inactivityDays: number;
    dryRun: boolean;
  }> = [];

  let safetyBlockedCount = 0;
  const safetyCheckResults: Array<{
    address: string;
    eligible: boolean;
    reasons: string[];
  }> = [];

  for (const secret of sourceSecrets) {
    const keypair = StellarSdk.Keypair.fromSecret(secret);
    const publicKey = keypair.publicKey();

    if (!skipSafetyChecks) {
      try {
        const safetyResult = await runMergeSafetyChecks(publicKey);
        safetyCheckResults.push({
          address: publicKey,
          eligible: safetyResult.eligible,
          reasons: safetyResult.reasons,
        });

        if (!safetyResult.eligible) {
          safetyBlockedCount++;
          logger.warn(
            {
              address: publicKey,
              reasons: safetyResult.reasons,
              hasActiveDisputes: safetyResult.hasActiveDisputes,
              hasPendingTransactions: safetyResult.hasPendingTransactions,
              requiresManualReview: safetyResult.requiresManualReview,
            },
            `${ACCOUNT_MERGE_PREFIX} Account merge blocked by safety checks`,
          );
          continue;
        }
      } catch (err) {
        logger.error(
          { error: err, address: publicKey },
          `${ACCOUNT_MERGE_PREFIX} Safety check failed; skipping account`,
        );
        continue;
      }
    }

    qualifiedJobs.push({
      sourceSecret: secret,
      destinationPublicKey: destination,
      inactivityDays,
      dryRun,
    });
  }

  if (qualifiedJobs.length === 0) {
    console.log(
      `${ACCOUNT_MERGE_PREFIX} No accounts passed safety checks (${safetyBlockedCount} blocked)`,
    );
    return;
  }

  const queuedJobs = await addBatchAccountMergeJobs(qualifiedJobs);

  console.log(
    `${ACCOUNT_MERGE_PREFIX} Queued ${queuedJobs.length} account merge jobs for processing (${safetyBlockedCount} blocked by safety checks)`,
  );

  if (safetyCheckResults.length > 0) {
    logger.info(
      {
        total: sourceSecrets.length,
        qualified: qualifiedJobs.length,
        blocked: safetyBlockedCount,
        details: safetyCheckResults,
      },
      `${ACCOUNT_MERGE_PREFIX} Safety check summary`,
    );
  }
}

/**
 * Get summary of reclaimed base reserves from completed merge jobs.
 * This can be called after jobs complete to log total reclaimed XLM.
 */
export async function getAccountMergeSummary(): Promise<{
  totalQueued: number;
  destination: string | null;
}> {
  const sourceSecrets = parseAuxiliaryAccountSecrets();
  const destination = resolveMergeDestinationPublicKey();

  return {
    totalQueued: sourceSecrets.length,
    destination,
  };
}
