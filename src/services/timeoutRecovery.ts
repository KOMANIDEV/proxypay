/**
 * @file src/services/timeoutRecovery.ts
 *
 * Configurable Transaction Timeout Recovery (Issue #422)
 *
 * Provides policy-based recovery for transactions that time out.
 *
 * Recovery strategies:
 *  - "retry"        — Automatically retry the transaction up to maxRetries times
 *                     with configurable back-off.
 *  - "manual_review"— Move the transaction to a manual review queue for
 *                     human intervention.
 *  - "fail_fast"    — Immediately mark the transaction as failed without retry.
 *  - "rollback"     — Attempt to reverse any partial changes and mark as failed.
 *
 * Policy resolution:
 *  - Policies are matched by transaction type, provider, and amount thresholds.
 *  - The first matching policy wins; a default policy is always applied when no
 *    specific policy matches.
 *  - Policies are configurable via environment variables or runtime registration.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimeoutRecoveryStrategy =
  | "retry"
  | "manual_review"
  | "fail_fast"
  | "rollback";

/**
 * A single timeout recovery policy.
 */
export interface TimeoutRecoveryPolicy {
  /** Unique policy name for logging and debugging. */
  name: string;
  /** Recovery strategy to apply when this policy matches. */
  strategy: TimeoutRecoveryStrategy;
  /**
   * Optional filter — if set, only applies to transactions whose `type`
   * matches one of these values. Leave undefined to match all types.
   */
  transactionTypes?: string[];
  /**
   * Optional filter — if set, only applies to transactions whose `provider`
   * matches. Leave undefined to match all providers.
   */
  providers?: string[];
  /**
   * Optional minimum transaction amount (in the transaction's currency unit)
   * for this policy to apply.
   */
  minAmount?: number;
  /**
   * Optional maximum transaction amount. For amounts above this threshold a
   * more conservative policy (e.g. manual_review) is typically used.
   */
  maxAmount?: number;
  /**
   * Maximum number of automatic retry attempts.
   * Relevant only when `strategy === "retry"`. Default: 3.
   */
  maxRetries?: number;
  /**
   * Delay in milliseconds between retry attempts.
   * Relevant only when `strategy === "retry"`. Default: 2000.
   */
  retryDelayMs?: number;
  /**
   * Whether exponential back-off is applied between retry attempts.
   * Default: true.
   */
  exponentialBackoff?: boolean;
}

/**
 * The context passed to the recovery engine per timed-out transaction.
 */
export interface TimeoutRecoveryContext {
  transactionId: string;
  type: string;
  provider: string;
  amount: number;
  currency: string;
  /** Number of recovery attempts already made for this transaction. */
  attemptCount: number;
  /** ISO timestamp of the original timeout. */
  timedOutAt: string;
  /** Any additional metadata from the transaction. */
  metadata?: Record<string, unknown>;
}

/**
 * The result of a single recovery decision.
 */
export interface TimeoutRecoveryResult {
  transactionId: string;
  strategy: TimeoutRecoveryStrategy;
  policyName: string;
  actionTaken: string;
  shouldRetry: boolean;
  retryAfterMs?: number;
  queuedForManualReview?: boolean;
  failedImmediately?: boolean;
  error?: string;
}

/**
 * A manual review queue entry.
 */
export interface ManualReviewQueueEntry {
  id: string;
  transactionId: string;
  context: TimeoutRecoveryContext;
  policyName: string;
  queuedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolution: "retried" | "cancelled" | "approved" | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Built-in default policies
// ---------------------------------------------------------------------------

/**
 * The system default policy — applied when no specific policy matches.
 * Uses "manual_review" as the safest conservative fallback.
 */
export const DEFAULT_POLICY: TimeoutRecoveryPolicy = {
  name: "default",
  strategy: "manual_review",
  maxRetries: 3,
  retryDelayMs: 2000,
  exponentialBackoff: true,
};

/**
 * Built-in policy set covering common scenarios.
 * These are applied in order; first match wins.
 */
export const BUILT_IN_POLICIES: TimeoutRecoveryPolicy[] = [
  {
    name: "high-value-manual-review",
    strategy: "manual_review",
    minAmount: 100_000,
    maxRetries: 0,
  },
  {
    name: "deposit-retry",
    strategy: "retry",
    transactionTypes: ["deposit"],
    maxRetries: 3,
    retryDelayMs: 3000,
    exponentialBackoff: true,
  },
  {
    name: "withdraw-manual-review",
    strategy: "manual_review",
    transactionTypes: ["withdraw"],
    maxRetries: 1,
    retryDelayMs: 5000,
    exponentialBackoff: false,
  },
  {
    name: "stellar-retry",
    strategy: "retry",
    providers: ["stellar"],
    maxRetries: 5,
    retryDelayMs: 1000,
    exponentialBackoff: true,
  },
  {
    name: "small-amount-fail-fast",
    strategy: "fail_fast",
    maxAmount: 500,
    maxRetries: 0,
  },
];

// ---------------------------------------------------------------------------
// Policy registry
// ---------------------------------------------------------------------------

/** Runtime-registered policies (prepended, so they take priority). */
const customPolicies: TimeoutRecoveryPolicy[] = [];

/** Manual review queue (in-memory — replace with a DB table in production). */
const manualReviewQueue: ManualReviewQueueEntry[] = [];

/**
 * Register a custom recovery policy at runtime.
 * Custom policies are checked before built-in policies.
 */
export function registerRecoveryPolicy(policy: TimeoutRecoveryPolicy): void {
  customPolicies.unshift(policy);
}

/** Remove all custom policies (useful for test isolation). */
export function clearCustomPolicies(): void {
  customPolicies.length = 0;
}

/** Clear the manual review queue (for testing only). */
export function clearManualReviewQueue(): void {
  manualReviewQueue.length = 0;
}

// ---------------------------------------------------------------------------
// Policy matching
// ---------------------------------------------------------------------------

/**
 * Check whether a policy applies to the given recovery context.
 */
export function policyMatches(
  policy: TimeoutRecoveryPolicy,
  ctx: TimeoutRecoveryContext,
): boolean {
  if (policy.transactionTypes && !policy.transactionTypes.includes(ctx.type)) {
    return false;
  }
  if (policy.providers && !policy.providers.includes(ctx.provider)) {
    return false;
  }
  if (policy.minAmount !== undefined && ctx.amount < policy.minAmount) {
    return false;
  }
  if (policy.maxAmount !== undefined && ctx.amount > policy.maxAmount) {
    return false;
  }
  return true;
}

/**
 * Select the best matching policy for a recovery context.
 * Order of precedence: custom policies → built-in policies → default policy.
 */
export function selectPolicy(
  ctx: TimeoutRecoveryContext,
  builtInPolicies = BUILT_IN_POLICIES,
): TimeoutRecoveryPolicy {
  for (const policy of [...customPolicies, ...builtInPolicies]) {
    if (policyMatches(policy, ctx)) {
      return policy;
    }
  }
  return DEFAULT_POLICY;
}

// ---------------------------------------------------------------------------
// Recovery decision engine
// ---------------------------------------------------------------------------

/**
 * Calculate the delay before the next retry attempt.
 */
export function calculateRetryDelay(
  policy: TimeoutRecoveryPolicy,
  attemptCount: number,
): number {
  const base = policy.retryDelayMs ?? 2000;
  if (!policy.exponentialBackoff) return base;
  // 2^attempt * base, capped at 60 seconds
  return Math.min(base * Math.pow(2, attemptCount), 60_000);
}

/**
 * Core recovery decision function.
 *
 * Selects the appropriate policy for the timed-out transaction, applies the
 * recovery strategy, and returns a detailed result.
 */
export function decideRecovery(
  ctx: TimeoutRecoveryContext,
  builtInPolicies = BUILT_IN_POLICIES,
): TimeoutRecoveryResult {
  const policy = selectPolicy(ctx, builtInPolicies);
  const maxRetries = policy.maxRetries ?? 3;

  switch (policy.strategy) {
    case "retry": {
      const canRetry = ctx.attemptCount < maxRetries;
      const retryAfterMs = canRetry
        ? calculateRetryDelay(policy, ctx.attemptCount)
        : undefined;

      if (!canRetry) {
        // Exhausted retries — fall back to manual review
        return {
          transactionId: ctx.transactionId,
          strategy: "retry",
          policyName: policy.name,
          actionTaken: `Retry limit (${maxRetries}) exhausted — moved to manual review`,
          shouldRetry: false,
          queuedForManualReview: true,
        };
      }

      return {
        transactionId: ctx.transactionId,
        strategy: "retry",
        policyName: policy.name,
        actionTaken: `Retry attempt ${ctx.attemptCount + 1} of ${maxRetries}`,
        shouldRetry: true,
        retryAfterMs,
      };
    }

    case "manual_review": {
      return {
        transactionId: ctx.transactionId,
        strategy: "manual_review",
        policyName: policy.name,
        actionTaken: "Transaction queued for manual review",
        shouldRetry: false,
        queuedForManualReview: true,
      };
    }

    case "fail_fast": {
      return {
        transactionId: ctx.transactionId,
        strategy: "fail_fast",
        policyName: policy.name,
        actionTaken: "Transaction immediately failed (fail-fast policy)",
        shouldRetry: false,
        failedImmediately: true,
      };
    }

    case "rollback": {
      return {
        transactionId: ctx.transactionId,
        strategy: "rollback",
        policyName: policy.name,
        actionTaken: "Transaction marked for rollback",
        shouldRetry: false,
        failedImmediately: true,
      };
    }

    default: {
      return {
        transactionId: ctx.transactionId,
        strategy: "fail_fast",
        policyName: "unknown",
        actionTaken: "Unknown strategy — defaulting to fail-fast",
        shouldRetry: false,
        failedImmediately: true,
        error: `Unknown strategy: ${(policy as any).strategy}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Manual review queue management
// ---------------------------------------------------------------------------

/**
 * Add a timed-out transaction to the manual review queue.
 */
export function queueForManualReview(
  ctx: TimeoutRecoveryContext,
  policyName: string,
): ManualReviewQueueEntry {
  const entry: ManualReviewQueueEntry = {
    id: `review-${ctx.transactionId}-${Date.now()}`,
    transactionId: ctx.transactionId,
    context: ctx,
    policyName,
    queuedAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    notes: null,
  };
  manualReviewQueue.push(entry);
  return entry;
}

/**
 * Retrieve all pending (unresolved) manual review entries.
 */
export function getPendingManualReviews(): ManualReviewQueueEntry[] {
  return manualReviewQueue.filter((e) => e.resolution === null);
}

/**
 * Retrieve all manual review entries (including resolved).
 */
export function getAllManualReviews(): ManualReviewQueueEntry[] {
  return [...manualReviewQueue];
}

/**
 * Resolve a manual review entry.
 *
 * @param entryId     The manual review entry ID.
 * @param resolution  The resolution action taken.
 * @param resolvedBy  Identifier of the agent who resolved it.
 * @param notes       Optional notes.
 */
export function resolveManualReview(
  entryId: string,
  resolution: ManualReviewQueueEntry["resolution"],
  resolvedBy: string,
  notes?: string,
): ManualReviewQueueEntry {
  const entry = manualReviewQueue.find((e) => e.id === entryId);
  if (!entry) {
    throw new Error(`Manual review entry ${entryId} not found`);
  }
  entry.resolvedAt = new Date();
  entry.resolvedBy = resolvedBy;
  entry.resolution = resolution;
  entry.notes = notes ?? null;
  return entry;
}

// ---------------------------------------------------------------------------
// High-level orchestrator
// ---------------------------------------------------------------------------

/**
 * Handle a timed-out transaction end-to-end:
 *  1. Select the matching recovery policy.
 *  2. Decide on the recovery action.
 *  3. If the strategy requires manual review, add to the queue.
 *  4. Return the full result for the caller to act on.
 */
export function handleTransactionTimeout(
  ctx: TimeoutRecoveryContext,
  builtInPolicies = BUILT_IN_POLICIES,
): TimeoutRecoveryResult {
  const result = decideRecovery(ctx, builtInPolicies);

  if (result.queuedForManualReview) {
    queueForManualReview(ctx, result.policyName);
  }

  return result;
}
