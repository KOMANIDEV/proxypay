/**
 * Tests for Configurable Transaction Timeout Recovery (Issue #422)
 *
 * Covers:
 *  - policyMatches() — policy selection logic
 *  - selectPolicy()  — precedence: custom → built-in → default
 *  - calculateRetryDelay() — exponential back-off and fixed delay
 *  - decideRecovery() — all four strategy paths
 *  - handleTransactionTimeout() — end-to-end orchestration
 *  - Manual review queue — queue, list, resolve
 *  - Custom policy registration and clearance
 *  - Retry exhaustion fallback to manual review
 */

import {
  TimeoutRecoveryContext,
  TimeoutRecoveryPolicy,
  policyMatches,
  selectPolicy,
  calculateRetryDelay,
  decideRecovery,
  handleTransactionTimeout,
  queueForManualReview,
  getPendingManualReviews,
  getAllManualReviews,
  resolveManualReview,
  registerRecoveryPolicy,
  clearCustomPolicies,
  clearManualReviewQueue,
  DEFAULT_POLICY,
  BUILT_IN_POLICIES,
} from "../../src/services/timeoutRecovery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeCtx = (
  overrides: Partial<TimeoutRecoveryContext> = {},
): TimeoutRecoveryContext => ({
  transactionId: "txn-001",
  type: "deposit",
  provider: "mtn",
  amount: 10_000,
  currency: "XAF",
  attemptCount: 0,
  timedOutAt: new Date().toISOString(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("policyMatches()", () => {
  const policy: TimeoutRecoveryPolicy = {
    name: "test",
    strategy: "retry",
    transactionTypes: ["deposit"],
    providers: ["mtn"],
    minAmount: 1_000,
    maxAmount: 50_000,
  };

  it("matches when all filters satisfy the context", () => {
    expect(policyMatches(policy, makeCtx())).toBe(true);
  });

  it("does not match wrong transaction type", () => {
    expect(policyMatches(policy, makeCtx({ type: "withdraw" }))).toBe(false);
  });

  it("does not match wrong provider", () => {
    expect(policyMatches(policy, makeCtx({ provider: "airtel" }))).toBe(false);
  });

  it("does not match amount below minAmount", () => {
    expect(policyMatches(policy, makeCtx({ amount: 500 }))).toBe(false);
  });

  it("does not match amount above maxAmount", () => {
    expect(policyMatches(policy, makeCtx({ amount: 100_000 }))).toBe(false);
  });

  it("matches when no filters are specified (catch-all)", () => {
    const catchAll: TimeoutRecoveryPolicy = { name: "all", strategy: "fail_fast" };
    expect(policyMatches(catchAll, makeCtx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("selectPolicy()", () => {
  afterEach(() => {
    clearCustomPolicies();
  });

  it("returns a built-in policy when context matches", () => {
    const ctx = makeCtx({ type: "deposit", provider: "mtn", amount: 10_000 });
    const policy = selectPolicy(ctx);
    expect(policy.name).toBeDefined();
    expect(["deposit-retry", "stellar-retry", "high-value-manual-review", "small-amount-fail-fast", "withdraw-manual-review"]).toContain(policy.name);
  });

  it("returns the default policy when nothing matches", () => {
    const ctx = makeCtx({
      type: "unknown-type",
      provider: "unknown-provider",
      amount: 25_000,
    });
    // Use an empty built-in list so only default applies
    const policy = selectPolicy(ctx, []);
    expect(policy.name).toBe("default");
  });

  it("custom policy takes precedence over built-in policies", () => {
    registerRecoveryPolicy({
      name: "custom-fail-fast",
      strategy: "fail_fast",
      transactionTypes: ["deposit"],
    });

    const policy = selectPolicy(makeCtx({ type: "deposit", amount: 10_000 }));
    expect(policy.name).toBe("custom-fail-fast");
  });

  it("high-value transactions match high-value-manual-review policy", () => {
    const policy = selectPolicy(makeCtx({ amount: 200_000 }));
    expect(policy.name).toBe("high-value-manual-review");
  });

  it("small amounts match small-amount-fail-fast policy", () => {
    const policy = selectPolicy(makeCtx({ amount: 100, type: "unknown" }));
    expect(policy.name).toBe("small-amount-fail-fast");
  });
});

// ---------------------------------------------------------------------------

describe("calculateRetryDelay()", () => {
  it("returns the base delay when exponential backoff is disabled", () => {
    const policy: TimeoutRecoveryPolicy = {
      name: "p",
      strategy: "retry",
      retryDelayMs: 2000,
      exponentialBackoff: false,
    };
    expect(calculateRetryDelay(policy, 0)).toBe(2000);
    expect(calculateRetryDelay(policy, 3)).toBe(2000);
  });

  it("doubles the delay on each attempt with exponential backoff", () => {
    const policy: TimeoutRecoveryPolicy = {
      name: "p",
      strategy: "retry",
      retryDelayMs: 1000,
      exponentialBackoff: true,
    };
    expect(calculateRetryDelay(policy, 0)).toBe(1000);
    expect(calculateRetryDelay(policy, 1)).toBe(2000);
    expect(calculateRetryDelay(policy, 2)).toBe(4000);
    expect(calculateRetryDelay(policy, 3)).toBe(8000);
  });

  it("caps delay at 60 seconds", () => {
    const policy: TimeoutRecoveryPolicy = {
      name: "p",
      strategy: "retry",
      retryDelayMs: 5000,
      exponentialBackoff: true,
    };
    // attempt 10 → 5000 * 2^10 = 5,120,000 ms — should cap at 60,000
    expect(calculateRetryDelay(policy, 10)).toBe(60_000);
  });

  it("uses default delay when retryDelayMs is not set", () => {
    const policy: TimeoutRecoveryPolicy = {
      name: "p",
      strategy: "retry",
      exponentialBackoff: false,
    };
    expect(calculateRetryDelay(policy, 0)).toBe(2000);
  });
});

// ---------------------------------------------------------------------------

describe("decideRecovery()", () => {
  describe("retry strategy", () => {
    const retryPolicy: TimeoutRecoveryPolicy = {
      name: "retry-test",
      strategy: "retry",
      maxRetries: 3,
      retryDelayMs: 1000,
      exponentialBackoff: false,
    };

    it("returns shouldRetry=true when attempts remain", () => {
      const result = decideRecovery(makeCtx({ attemptCount: 0 }), [retryPolicy]);
      expect(result.shouldRetry).toBe(true);
      expect(result.retryAfterMs).toBe(1000);
      expect(result.strategy).toBe("retry");
      expect(result.policyName).toBe("retry-test");
    });

    it("falls back to manual review when retries are exhausted", () => {
      const result = decideRecovery(makeCtx({ attemptCount: 3 }), [retryPolicy]);
      expect(result.shouldRetry).toBe(false);
      expect(result.queuedForManualReview).toBe(true);
    });

    it("includes action description in result", () => {
      const result = decideRecovery(makeCtx({ attemptCount: 1 }), [retryPolicy]);
      expect(result.actionTaken).toContain("2 of 3");
    });
  });

  describe("manual_review strategy", () => {
    const reviewPolicy: TimeoutRecoveryPolicy = {
      name: "manual-test",
      strategy: "manual_review",
    };

    it("returns queuedForManualReview=true", () => {
      const result = decideRecovery(makeCtx(), [reviewPolicy]);
      expect(result.strategy).toBe("manual_review");
      expect(result.shouldRetry).toBe(false);
      expect(result.queuedForManualReview).toBe(true);
    });
  });

  describe("fail_fast strategy", () => {
    const failFastPolicy: TimeoutRecoveryPolicy = {
      name: "fail-test",
      strategy: "fail_fast",
    };

    it("returns failedImmediately=true", () => {
      const result = decideRecovery(makeCtx(), [failFastPolicy]);
      expect(result.strategy).toBe("fail_fast");
      expect(result.shouldRetry).toBe(false);
      expect(result.failedImmediately).toBe(true);
    });
  });

  describe("rollback strategy", () => {
    const rollbackPolicy: TimeoutRecoveryPolicy = {
      name: "rollback-test",
      strategy: "rollback",
    };

    it("returns failedImmediately=true", () => {
      const result = decideRecovery(makeCtx(), [rollbackPolicy]);
      expect(result.strategy).toBe("rollback");
      expect(result.failedImmediately).toBe(true);
    });
  });

  describe("falls back to default policy", () => {
    it("uses DEFAULT_POLICY when built-in list is empty and no custom policies", () => {
      clearCustomPolicies();
      const ctx = makeCtx({ type: "exotic", provider: "xyz", amount: 25_000 });
      const result = decideRecovery(ctx, []);
      expect(result.policyName).toBe("default");
      expect(result.queuedForManualReview).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------

describe("handleTransactionTimeout()", () => {
  afterEach(() => {
    clearManualReviewQueue();
    clearCustomPolicies();
  });

  it("adds a manual review entry when strategy is manual_review", () => {
    const reviewPolicy: TimeoutRecoveryPolicy = {
      name: "review-all",
      strategy: "manual_review",
    };

    const ctx = makeCtx({ transactionId: "txn-manual-1" });
    handleTransactionTimeout(ctx, [reviewPolicy]);

    const pending = getPendingManualReviews();
    expect(pending.some((e) => e.transactionId === "txn-manual-1")).toBe(true);
  });

  it("does NOT add a manual review entry for fail_fast strategy", () => {
    const failPolicy: TimeoutRecoveryPolicy = {
      name: "fail-all",
      strategy: "fail_fast",
    };

    const ctx = makeCtx({ transactionId: "txn-fail-1" });
    handleTransactionTimeout(ctx, [failPolicy]);

    const all = getAllManualReviews();
    expect(all.some((e) => e.transactionId === "txn-fail-1")).toBe(false);
  });

  it("adds a manual review entry when retry attempts are exhausted", () => {
    const retryPolicy: TimeoutRecoveryPolicy = {
      name: "limited-retry",
      strategy: "retry",
      maxRetries: 2,
    };

    const ctx = makeCtx({
      transactionId: "txn-exhausted-1",
      attemptCount: 2,
    });
    handleTransactionTimeout(ctx, [retryPolicy]);

    const pending = getPendingManualReviews();
    expect(pending.some((e) => e.transactionId === "txn-exhausted-1")).toBe(true);
  });

  it("returns the full recovery result", () => {
    const ctx = makeCtx();
    const result = handleTransactionTimeout(ctx, []);

    expect(result).toHaveProperty("transactionId");
    expect(result).toHaveProperty("strategy");
    expect(result).toHaveProperty("policyName");
    expect(result).toHaveProperty("actionTaken");
    expect(result).toHaveProperty("shouldRetry");
  });
});

// ---------------------------------------------------------------------------

describe("Manual review queue", () => {
  afterEach(() => {
    clearManualReviewQueue();
  });

  it("queueForManualReview adds an entry to the queue", () => {
    const ctx = makeCtx({ transactionId: "txn-q-1" });
    const entry = queueForManualReview(ctx, "test-policy");

    expect(entry.transactionId).toBe("txn-q-1");
    expect(entry.resolution).toBeNull();
    expect(entry.policyName).toBe("test-policy");
  });

  it("getPendingManualReviews returns only unresolved entries", () => {
    const e1 = queueForManualReview(makeCtx({ transactionId: "txn-p-1" }), "p");
    const e2 = queueForManualReview(makeCtx({ transactionId: "txn-p-2" }), "p");

    resolveManualReview(e1.id, "approved", "agent-1");

    const pending = getPendingManualReviews();
    expect(pending.map((e) => e.id)).not.toContain(e1.id);
    expect(pending.map((e) => e.id)).toContain(e2.id);
  });

  it("resolveManualReview sets resolution fields", () => {
    const entry = queueForManualReview(makeCtx(), "test");
    const resolved = resolveManualReview(entry.id, "retried", "agent-2", "Retried manually");

    expect(resolved.resolution).toBe("retried");
    expect(resolved.resolvedBy).toBe("agent-2");
    expect(resolved.notes).toBe("Retried manually");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  it("throws when resolving a non-existent entry", () => {
    expect(() =>
      resolveManualReview("does-not-exist", "cancelled", "agent"),
    ).toThrow("not found");
  });

  it("getAllManualReviews returns all entries including resolved", () => {
    const e1 = queueForManualReview(makeCtx({ transactionId: "txn-a-1" }), "p");
    const e2 = queueForManualReview(makeCtx({ transactionId: "txn-a-2" }), "p");
    resolveManualReview(e1.id, "cancelled", "agent");

    const all = getAllManualReviews();
    expect(all.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("Custom policy registration", () => {
  afterEach(() => {
    clearCustomPolicies();
  });

  it("registerRecoveryPolicy adds a policy that takes priority", () => {
    registerRecoveryPolicy({
      name: "my-custom-policy",
      strategy: "rollback",
      transactionTypes: ["deposit"],
    });

    const policy = selectPolicy(makeCtx({ type: "deposit" }));
    expect(policy.name).toBe("my-custom-policy");
    expect(policy.strategy).toBe("rollback");
  });

  it("clearCustomPolicies removes all custom policies", () => {
    registerRecoveryPolicy({
      name: "temp-policy",
      strategy: "fail_fast",
    });

    clearCustomPolicies();

    const policy = selectPolicy(makeCtx({ type: "deposit", amount: 10_000 }));
    expect(policy.name).not.toBe("temp-policy");
  });
});
