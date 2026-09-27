/**
 * @file src/services/accountMergeDryRun.ts
 *
 * Stellar Account Merge Dry-Run Service (Issue #421)
 *
 * Provides safe, non-destructive simulation of account merge operations.
 *
 * Features:
 *  - Pre-merge validation checks (balances, trustlines, signers, sequence numbers)
 *  - Detailed impact report showing what *would* happen on a real merge
 *  - Merchant review capability — return a ReviewReport that must be
 *    explicitly approved before the merge is executed.
 *  - Zero Stellar network state is modified (all checks are read-only).
 */

import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import { queryRead, queryWrite } from "../config/database";
import {
  evaluateAccountMergeCandidate,
  xlmToStroops,
  stroopsToXlm,
  AccountMergeCandidate,
} from "../jobs/accountMerge";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A single pre-merge check result. */
export interface PreMergeCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Per-trustline information gathered during a dry-run. */
export interface TrustlineInfo {
  assetCode: string;
  assetIssuer: string;
  balance: string;
  limit: string;
  isAuthorised: boolean;
}

/** Per-signer information gathered during a dry-run. */
export interface SignerInfo {
  key: string;
  weight: number;
  type: string;
}

/** Complete dry-run validation report for a single account. */
export interface AccountMergeDryRunReport {
  /** Stellar public key of the source account. */
  sourcePublicKey: string;
  /** Stellar public key of the destination account. */
  destinationPublicKey: string;
  /** Whether the merge is eligible to proceed. */
  eligible: boolean;
  /** Human-readable summary of the eligibility outcome. */
  summary: string;
  /** Native XLM balance that would be reclaimed. */
  reclaimableXLM: string;
  /** Number of subentries (trustlines, offers, signers, data). */
  subentryCount: number;
  /** Trustlines currently on the source account. */
  trustlines: TrustlineInfo[];
  /** Signers configured on the source account. */
  signers: SignerInfo[];
  /** Current sequence number of the source account. */
  sequenceNumber: string;
  /** Date of last on-chain activity (or null if no transactions found). */
  lastActivityAt: Date | null;
  /** Ordered list of individual pre-merge checks performed. */
  checks: PreMergeCheck[];
  /** Whether the account was found on Horizon. */
  accountFound: boolean;
  /** ISO timestamp when this report was generated. */
  generatedAt: string;
}

/** Result of running dry-run on multiple accounts in batch. */
export interface BatchDryRunResult {
  totalAccounts: number;
  eligible: number;
  ineligible: number;
  notFound: number;
  totalReclaimableXLM: string;
  reports: AccountMergeDryRunReport[];
}

/** PostgreSQL unique-violation, raised by the one-pending-review-per-account index. */
const PG_UNIQUE_VIOLATION = "23505";

/** Merchant review record: wraps a dry-run report with approval state. */
export interface MerchantReviewRecord {
  id: string;
  sourcePublicKey: string;
  dryRunReport: AccountMergeDryRunReport;
  reviewRequestedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  approved: boolean | null;
  reviewNotes: string | null;
}

// ---------------------------------------------------------------------------
// Persistent merchant review store (#570)
// ---------------------------------------------------------------------------

/**
 * Reviews live in `account_merge_reviews` (migration 20260830), not in a Map.
 *
 * Everything in this section is async as a consequence, including the four
 * exported functions, which were synchronous before #570. That is a breaking
 * change for callers and the existing test file has been updated to await them.
 * It is not optional: a synchronous API over durable storage is not expressible,
 * and pretending otherwise is what the Map was.
 *
 * Two behaviours the Map could not have provided, and which matter more than
 * the persistence itself:
 *
 *  - One pending review per source account, enforced by a partial unique index.
 *    The Map happily held fifty open reviews of the same account; a reviewer
 *    could then approve one of them and nobody would know which was current.
 *  - Reviews expire. A dry run is a snapshot of a moment, and an approval of a
 *    report from three weeks ago is approving numbers that have since changed.
 */

/** How long a pending review stays valid before it needs re-running. */
const REVIEW_TTL_DAYS = 7;

function mapReviewRow(row: Record<string, any>): MerchantReviewRecord {
  return {
    id: row.id,
    sourcePublicKey: row.source_public_key,
    dryRunReport: row.dry_run_report,
    reviewRequestedAt: row.review_requested_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    approved: row.status === "approved" ? true : row.status === "rejected" ? false : null,
    reviewNotes: row.review_notes ?? null,
  };
}

export async function submitForMerchantReview(
  report: AccountMergeDryRunReport,
): Promise<MerchantReviewRecord> {
  const record: Omit<MerchantReviewRecord, "id"> = {
    // Not derived from the key and a timestamp any more. That scheme collided
    // for two submissions of the same account inside the same millisecond and
    // leaked the account key into an identifier that ends up in log lines and
    // URLs.
    sourcePublicKey: report.sourcePublicKey,
    dryRunReport: report,
    reviewRequestedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
    approved: null,
    reviewNotes: null,
  };

  try {
    const result = await queryWrite(
      `INSERT INTO account_merge_reviews
         (source_public_key, dry_run_report, status, review_requested_at, reclaimable_xlm)
       VALUES ($1, $2, 'pending', $3, $4)
       RETURNING *`,
      [
        record.sourcePublicKey,
        JSON.stringify(record.dryRunReport),
        record.reviewRequestedAt,
        report.reclaimableXLM,
      ],
    );
    return mapReviewRow(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
      throw new Error(
        `A pending review already exists for account ${report.sourcePublicKey}`,
      );
    }
    throw error;
  }
}

export async function recordMerchantReviewDecision(
  reviewId: string,
  approved: boolean,
  reviewedBy: string,
  notes?: string,
): Promise<MerchantReviewRecord> {
  // The status guard is part of the WHERE clause, not a check in JavaScript.
  // Two reviewers clicking approve at the same moment is not a hypothetical, and
  // the second one must be told the review was already decided rather than
  // overwriting the first decision and the first reviewer's name.
  const result = await queryWrite(
    `UPDATE account_merge_reviews
        SET status        = $2,
            reviewed_at   = NOW(),
            reviewed_by   = $3,
            review_notes  = $4,
            updated_at    = NOW()
      WHERE id = $1
        AND status = 'pending'
      RETURNING *`,
    [reviewId, approved ? "approved" : "rejected", reviewedBy, notes ?? null],
  );

  if (result.rows.length === 0) {
    // Distinguish "no such review" from "already decided": the first is a bad
    // request, the second is a conflict, and they warrant different responses.
    const existing = await queryRead(
      "SELECT status, reviewed_by, reviewed_at FROM account_merge_reviews WHERE id = $1",
      [reviewId],
    );
    if (existing.rows.length === 0) {
      throw new Error(`Review record ${reviewId} not found`);
    }
    throw new Error(
      `Review ${reviewId} was already ${existing.rows[0].status}` +
        (existing.rows[0].reviewed_by ? ` by ${existing.rows[0].reviewed_by}` : ""),
    );
  }

  return mapReviewRow(result.rows[0]);
}

export async function getMerchantReviewRecord(
  reviewId: string,
): Promise<MerchantReviewRecord | undefined> {
  const result = await queryRead("SELECT * FROM account_merge_reviews WHERE id = $1", [reviewId]);
  return result.rows.length > 0 ? mapReviewRow(result.rows[0]) : undefined;
}

export async function getPendingMerchantReviews(): Promise<MerchantReviewRecord[]> {
  const result = await queryRead(
    `SELECT * FROM account_merge_reviews
      WHERE status = 'pending'
      ORDER BY review_requested_at DESC`,
  );
  return result.rows.map(mapReviewRow);
}

/**
 * Mark pending reviews older than the TTL as expired.
 *
 * Expiry is not a delete: the record of a review that went stale is part of the
 * audit trail, and the `expired` status is what distinguishes "nobody looked at
 * this" from "somebody looked and said no".
 */
export async function expireStaleMerchantReviews(
  ttlDays: number = REVIEW_TTL_DAYS,
): Promise<number> {
  const result = await queryWrite(
    `UPDATE account_merge_reviews
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending'
        AND review_requested_at < NOW() - ($1 || ' days')::interval
      RETURNING id`,
    [String(ttlDays)],
  );
  return result.rows.length;
}

/**
 * Was the review created inside its TTL?
 *
 * Checked before recording a decision, because the UPDATE above guards on
 * `status = 'pending'` but the row can still be pending *and* stale — nothing
 * runs the expiry sweep continuously. Rejecting a stale decision here is what
 * stops an approval of three-week-old numbers from going through simply because
 * nobody has swept the table.
 */
export async function assertReviewIsFresh(reviewId: string): Promise<void> {
  const result = await queryRead(
    `SELECT review_requested_at FROM account_merge_reviews WHERE id = $1`,
    [reviewId],
  );
  if (result.rows.length === 0) {
    throw new Error(`Review record ${reviewId} not found`);
  }
  const ageMs = Date.now() - new Date(result.rows[0].review_requested_at).getTime();
  if (ageMs > REVIEW_TTL_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error(
      `Review ${reviewId} is older than ${REVIEW_TTL_DAYS} days and must be re-run`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STROOPS_PER_XLM = 10_000_000n;

function nativeBalance(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): string {
  return (
    account.balances.find((b) => b.asset_type === "native")?.balance ?? "0"
  );
}

function getTrustlines(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): TrustlineInfo[] {
  return account.balances
    .filter((b) => b.asset_type !== "native")
    .map((b) => {
      const balance = b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset;
      return {
        assetCode: balance.asset_code ?? "",
        assetIssuer: balance.asset_issuer ?? "",
        balance: balance.balance,
        limit: balance.limit,
        isAuthorised: balance.is_authorized ?? false,
      };
    });
}

function getSigners(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): SignerInfo[] {
  return account.signers.map((s) => ({
    key: s.key,
    weight: s.weight,
    type: s.type,
  }));
}

async function fetchLastActivity(
  server: StellarSdk.Horizon.Server,
  publicKey: string,
): Promise<Date | null> {
  try {
    const response = await server
      .transactions()
      .forAccount(publicKey)
      .order("desc")
      .limit(1)
      .call();
    const tx = response.records[0];
    return tx ? new Date(tx.created_at) : null;
  } catch {
    return null;
  }
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { response?: { status?: number } };
  return e?.response?.status === 404;
}

// ---------------------------------------------------------------------------
// Core dry-run logic
// ---------------------------------------------------------------------------

/**
 * Run a complete pre-merge dry-run for a single account.
 *
 * @param sourcePublicKey       Ed25519 public key of the account to merge.
 * @param destinationPublicKey  Ed25519 public key of the merge destination.
 * @param inactivityDays        Number of days of inactivity required.
 * @param server                (Optional) Horizon server instance — injectable for tests.
 */
export async function runAccountMergeDryRun(
  sourcePublicKey: string,
  destinationPublicKey: string,
  inactivityDays = 30,
  server?: StellarSdk.Horizon.Server,
): Promise<AccountMergeDryRunReport> {
  const horizonServer = server ?? getStellarServer();
  const generatedAt = new Date().toISOString();
  const checks: PreMergeCheck[] = [];

  // --- Check 1: valid public keys ---
  const validSource = StellarSdk.StrKey.isValidEd25519PublicKey(sourcePublicKey);
  checks.push({
    name: "valid_source_key",
    passed: validSource,
    detail: validSource
      ? "Source public key is a valid Ed25519 key"
      : `Invalid source public key: ${sourcePublicKey}`,
  });

  const validDest = StellarSdk.StrKey.isValidEd25519PublicKey(destinationPublicKey);
  checks.push({
    name: "valid_destination_key",
    passed: validDest,
    detail: validDest
      ? "Destination public key is a valid Ed25519 key"
      : `Invalid destination public key: ${destinationPublicKey}`,
  });

  if (!validSource || !validDest) {
    return {
      sourcePublicKey,
      destinationPublicKey,
      eligible: false,
      summary: "Invalid public key(s) — cannot proceed with merge check",
      reclaimableXLM: "0",
      subentryCount: 0,
      trustlines: [],
      signers: [],
      sequenceNumber: "0",
      lastActivityAt: null,
      checks,
      accountFound: false,
      generatedAt,
    };
  }

  // --- Check 2: source ≠ destination ---
  const notSelf = sourcePublicKey !== destinationPublicKey;
  checks.push({
    name: "source_not_destination",
    passed: notSelf,
    detail: notSelf
      ? "Source and destination are different accounts"
      : "Source and destination are the same account — merge would be a no-op",
  });

  if (!notSelf) {
    return {
      sourcePublicKey,
      destinationPublicKey,
      eligible: false,
      summary: "Source and destination are the same account",
      reclaimableXLM: "0",
      subentryCount: 0,
      trustlines: [],
      signers: [],
      sequenceNumber: "0",
      lastActivityAt: null,
      checks,
      accountFound: false,
      generatedAt,
    };
  }

  // --- Fetch account from Horizon ---
  let account: StellarSdk.Horizon.ServerApi.AccountRecord;
  try {
    account = await horizonServer.loadAccount(sourcePublicKey);
  } catch (err) {
    const notFound = isNotFoundError(err);
    checks.push({
      name: "account_exists",
      passed: false,
      detail: notFound
        ? "Account not found on Horizon — it may have already been merged or never funded"
        : `Failed to load account: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      sourcePublicKey,
      destinationPublicKey,
      eligible: false,
      summary: notFound
        ? "Account not found on Horizon"
        : "Failed to fetch account from Horizon",
      reclaimableXLM: "0",
      subentryCount: 0,
      trustlines: [],
      signers: [],
      sequenceNumber: "0",
      lastActivityAt: null,
      checks,
      accountFound: false,
      generatedAt,
    };
  }

  checks.push({
    name: "account_exists",
    passed: true,
    detail: "Account found on Horizon",
  });

  // --- Gather account data ---
  const xlmBalance = nativeBalance(account);
  const trustlines = getTrustlines(account);
  const signers = getSigners(account);
  const sequenceNumber = account.sequence;
  const lastActivityAt = await fetchLastActivity(horizonServer, sourcePublicKey);

  const candidate: AccountMergeCandidate = {
    nativeBalance: xlmBalance,
    subentryCount: account.subentry_count,
    hasNonNativeBalances: trustlines.some(
      (t) => parseFloat(t.balance) > 0,
    ),
    lastActivityAt,
  };

  // --- Check 3: sufficient balance ---
  const balanceStroops = xlmToStroops(xlmBalance);
  const BASE_FEE = BigInt(StellarSdk.BASE_FEE.toString());
  const hasBalance = balanceStroops > BASE_FEE;
  checks.push({
    name: "sufficient_balance",
    passed: hasBalance,
    detail: hasBalance
      ? `Native balance ${xlmBalance} XLM is sufficient to cover the merge fee`
      : `Native balance ${xlmBalance} XLM is too low to cover the merge fee`,
  });

  // --- Check 4: no subentries ---
  const noSubentries = account.subentry_count === 0;
  checks.push({
    name: "no_subentries",
    passed: noSubentries,
    detail: noSubentries
      ? "Account has no subentries — safe to merge"
      : `Account has ${account.subentry_count} subentrie(s) that must be removed before merging`,
  });

  // --- Check 5: no non-native balances ---
  const noNonNative = !candidate.hasNonNativeBalances;
  checks.push({
    name: "no_non_native_balances",
    passed: noNonNative,
    detail: noNonNative
      ? "Account holds no non-native asset balances"
      : `Account holds non-native assets: ${trustlines.filter((t) => parseFloat(t.balance) > 0).map((t) => t.assetCode).join(", ")}`,
  });

  // --- Check 6: inactivity ---
  let isInactive = true;
  if (lastActivityAt) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - inactivityDays);
    isInactive = lastActivityAt <= cutoff;
  }
  checks.push({
    name: "inactivity_requirement",
    passed: isInactive,
    detail: isInactive
      ? `Account has been inactive for at least ${inactivityDays} day(s)`
      : `Account was active after the ${inactivityDays}-day inactivity cutoff (last activity: ${lastActivityAt?.toISOString() ?? "unknown"})`,
  });

  // --- Check 7: destination account exists ---
  let destExists = false;
  try {
    await horizonServer.loadAccount(destinationPublicKey);
    destExists = true;
  } catch {
    // destination may not exist — that's allowed for account merge
    destExists = false;
  }
  checks.push({
    name: "destination_exists",
    passed: destExists,
    detail: destExists
      ? "Destination account exists on Horizon"
      : "Destination account not found on Horizon (merge will create it)",
  });

  // --- Check 8: single primary signer (no multisig) ---
  const primarySigners = signers.filter(
    (s) => s.key === sourcePublicKey && s.weight > 0,
  );
  const isSimpleSigner = primarySigners.length === 1 && signers.length === 1;
  checks.push({
    name: "simple_signer",
    passed: isSimpleSigner,
    detail: isSimpleSigner
      ? "Account uses a simple single-signer configuration"
      : `Account has ${signers.length} signer(s) — verify multisig before merging`,
  });

  // --- Compute reclaimable balance ---
  const evaluation = evaluateAccountMergeCandidate(candidate, inactivityDays);

  const allChecksPassed = checks.every((c) => c.passed);

  return {
    sourcePublicKey,
    destinationPublicKey,
    eligible: allChecksPassed && evaluation.eligible,
    summary: evaluation.eligible && allChecksPassed
      ? `Account is eligible for merge — ${evaluation.reclaimableBalance} XLM will be reclaimed`
      : evaluation.reason
        ? `Account is ineligible: ${evaluation.reason}`
        : `Pre-merge checks failed — see individual checks for details`,
    reclaimableXLM: evaluation.reclaimableBalance,
    subentryCount: account.subentry_count,
    trustlines,
    signers,
    sequenceNumber,
    lastActivityAt,
    checks,
    accountFound: true,
    generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Batch dry-run
// ---------------------------------------------------------------------------

/**
 * Run dry-run checks on multiple accounts in parallel.
 */
export async function runBatchDryRun(
  accounts: Array<{
    sourcePublicKey: string;
    destinationPublicKey: string;
    inactivityDays?: number;
  }>,
  server?: StellarSdk.Horizon.Server,
): Promise<BatchDryRunResult> {
  const reports = await Promise.all(
    accounts.map(({ sourcePublicKey, destinationPublicKey, inactivityDays = 30 }) =>
      runAccountMergeDryRun(
        sourcePublicKey,
        destinationPublicKey,
        inactivityDays,
        server,
      ),
    ),
  );

  let totalReclaimableStroops = 0n;
  let eligible = 0;
  let ineligible = 0;
  let notFound = 0;

  for (const r of reports) {
    if (!r.accountFound) {
      notFound++;
    } else if (r.eligible) {
      eligible++;
      try {
        totalReclaimableStroops += xlmToStroops(r.reclaimableXLM);
      } catch {
        // ignore parse errors
      }
    } else {
      ineligible++;
    }
  }

  const totalReclaimableXLM =
    totalReclaimableStroops > 0n
      ? stroopsToXlm(totalReclaimableStroops)
      : "0";

  return {
    totalAccounts: reports.length,
    eligible,
    ineligible,
    notFound,
    totalReclaimableXLM,
    reports,
  };
}


