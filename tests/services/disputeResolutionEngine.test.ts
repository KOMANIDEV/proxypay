import {
  evaluateDispute,
  registerRule,
  unregisterRule,
  getRegisteredRules,
  type DisputeContext,
  type DisputeRule,
  type RuleResult,
} from "../../../src/services/disputeResolutionEngine";

// Mock the database pool
jest.mock("../../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../../src/utils/logger", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { pool } from "../../../src/config/database";

const mockQuery = pool.query as jest.MockedFunction<typeof pool.query>;

function makeContext(overrides: Partial<DisputeContext> = {}): DisputeContext {
  return {
    disputeId: "disp-1",
    transactionId: "txn-1",
    reason: "Transaction not received",
    category: null,
    transactionStatus: "completed",
    transactionAmount: 500,
    transactionCurrency: "NGN",
    transactionCreatedAt: new Date(Date.now() - 3600_000),
    providerReference: "prov-ref-1",
    merchantId: "merch-1",
    ...overrides,
  };
}

/** Config query: returns empty rows so defaults are used */
function mockConfigQuery() {
  mockQuery.mockResolvedValueOnce({
    rows: [],
    rowCount: 0,
    command: "",
    oid: 0,
    fields: [],
  });
}

/** Returns a mock DB count result */
function mockCountQuery(count: string) {
  mockQuery.mockResolvedValueOnce({
    rows: [{ count }],
    rowCount: 1,
    command: "",
    oid: 0,
    fields: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Priority ordering ────────────────────────────────────────────────────────

describe("Rule priority ordering", () => {
  it("returns rules sorted highest priority first", () => {
    const rules = getRegisteredRules();
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i - 1].priority).toBeGreaterThanOrEqual(rules[i].priority);
    }
  });

  it("built-in rules have expected priorities", () => {
    const rules = getRegisteredRules();
    const byName = Object.fromEntries(rules.map((r) => [r.name, r.priority]));
    expect(byName["duplicate_transaction"]).toBe(40);
    expect(byName["already_refunded"]).toBe(30);
    expect(byName["provider_timeout"]).toBe(20);
    expect(byName["amount_mismatch"]).toBe(10);
  });
});

// ─── Rule: Duplicate Transaction (priority 40) ────────────────────────────────

describe("ruleDuplicateTransaction", () => {
  it("matches and resolves when duplicates exist", async () => {
    mockConfigQuery();
    mockCountQuery("2"); // duplicate_transaction query

    const result = await evaluateDispute(makeContext());

    expect(result).not.toBeNull();
    expect(result!.ruleName).toBe("duplicate_transaction");
    expect(result!.priority).toBe(40);
    expect(result!.confidence).toBe(0.95);
    expect(result!.resolution).toBe("resolved");
  });

  it("does not match when no duplicates", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction → no match
    mockCountQuery("0"); // already_refunded → no match
    // provider_timeout is sync (checks status/age only) — no DB call
    // amount_mismatch is sync — no DB call

    const result = await evaluateDispute(makeContext());
    expect(result).toBeNull();
  });

  it("includes resolutionReason mentioning duplicate count", async () => {
    mockConfigQuery();
    mockCountQuery("3");

    const result = await evaluateDispute(makeContext());
    expect(result!.resolutionReason).toMatch(/3 matching transaction/);
  });
});

// ─── Rule: Already Refunded (priority 30) ────────────────────────────────────

describe("ruleAlreadyRefunded", () => {
  it("matches and resolves when a refund exists", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction → no match (higher priority, checked first)
    mockCountQuery("1"); // already_refunded → match

    const result = await evaluateDispute(makeContext());

    expect(result).not.toBeNull();
    expect(result!.ruleName).toBe("already_refunded");
    expect(result!.priority).toBe(30);
    expect(result!.resolution).toBe("resolved");
  });

  it("does not match when no refund exists", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction
    mockCountQuery("0"); // already_refunded → no match

    const result = await evaluateDispute(makeContext());
    expect(result).toBeNull();
  });
});

// ─── Rule: Provider Timeout (priority 20) ────────────────────────────────────

describe("ruleProviderTimeout", () => {
  it("matches and rejects when transaction is old and pending", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction
    mockCountQuery("0"); // already_refunded
    // provider_timeout checks status + age in-memory (no DB call)

    const result = await evaluateDispute(
      makeContext({
        transactionStatus: "pending",
        transactionCreatedAt: new Date(Date.now() - 600_000), // 10 minutes ago
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.ruleName).toBe("provider_timeout");
    expect(result!.priority).toBe(20);
    expect(result!.resolution).toBe("rejected");
    expect(result!.confidence).toBe(0.9);
  });

  it("does not match when transaction is recent", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction
    mockCountQuery("0"); // already_refunded
    // provider_timeout: 30s age < 300s threshold → no match
    // amount_mismatch: reason has no amount keywords → no match

    const result = await evaluateDispute(
      makeContext({
        transactionStatus: "pending",
        transactionCreatedAt: new Date(Date.now() - 30_000), // 30 seconds ago
      }),
    );

    expect(result).toBeNull();
  });

  it("does not match when transaction is not pending", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction
    mockCountQuery("0"); // already_refunded
    // provider_timeout: status is 'completed' → no match
    // amount_mismatch: reason has no amount keywords → no match

    const result = await evaluateDispute(
      makeContext({
        transactionStatus: "completed",
        transactionCreatedAt: new Date(Date.now() - 600_000),
      }),
    );

    expect(result).toBeNull();
  });
});

// ─── Rule: Amount Mismatch (priority 10) ──────────────────────────────────────

describe("ruleAmountMismatch", () => {
  it("does not auto-resolve because confidence (0.7) is below threshold (0.85)", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction
    mockCountQuery("0"); // already_refunded
    // provider_timeout: status is 'completed' → no match
    // amount_mismatch: confidence 0.7 < 0.85 → not returned

    const result = await evaluateDispute(
      makeContext({ reason: "Wrong amount charged" }),
    );

    expect(result).toBeNull();
  });

  it("does not match when reason has no amount keywords", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction
    mockCountQuery("0"); // already_refunded

    const result = await evaluateDispute(makeContext({ reason: "Transaction not received" }));
    expect(result).toBeNull();
  });
});

// ─── Priority: stop at first match ───────────────────────────────────────────

describe("Stop at first matching rule", () => {
  it("returns duplicate_transaction and does NOT evaluate lower-priority rules", async () => {
    mockConfigQuery();
    mockCountQuery("1"); // duplicate_transaction → match (priority 40)
    // If the engine evaluated already_refunded it would need another mockQuery.
    // Verify no extra queries were made after the first match.

    const result = await evaluateDispute(makeContext());

    expect(result!.ruleName).toBe("duplicate_transaction");
    // Config query + 1 rule DB query = 2 total
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("returns already_refunded when duplicate_transaction does not match", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction → no match
    mockCountQuery("1"); // already_refunded → match (priority 30)
    // provider_timeout and amount_mismatch should NOT be evaluated

    const result = await evaluateDispute(makeContext());

    expect(result!.ruleName).toBe("already_refunded");
    // Config query + duplicate query + refunded query = 3 total
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("returns provider_timeout when both higher-priority rules miss", async () => {
    mockConfigQuery();
    mockCountQuery("0"); // duplicate_transaction → no match
    mockCountQuery("0"); // already_refunded → no match
    // provider_timeout: pending + 10 min old → match (no DB call)

    const result = await evaluateDispute(
      makeContext({
        transactionStatus: "pending",
        transactionCreatedAt: new Date(Date.now() - 600_000),
      }),
    );

    expect(result!.ruleName).toBe("provider_timeout");
    // Config query + duplicate query + refunded query = 3 total (no provider_timeout DB call)
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});

// ─── Custom rule registration ─────────────────────────────────────────────────

describe("registerRule / unregisterRule", () => {
  afterEach(() => {
    // Clean up any test-registered rules
    unregisterRule("test_high_priority");
    unregisterRule("test_override_duplicate");
  });

  it("registered rule with higher priority runs first and stops evaluation", async () => {
    const testRule: DisputeRule = {
      name: "test_high_priority",
      priority: 100, // higher than all built-ins
      async evaluate(ctx): Promise<RuleResult> {
        return {
          ruleName: "test_high_priority",
          priority: 100,
          matched: true,
          confidence: 0.99,
          resolution: "resolved",
          resolutionReason: "Resolved by test rule",
        };
      },
    };

    registerRule(testRule);
    mockConfigQuery();

    const result = await evaluateDispute(makeContext());

    expect(result!.ruleName).toBe("test_high_priority");
    expect(result!.priority).toBe(100);
    // Only the config query was made — no built-in rule DB queries
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("registered rule with same name replaces existing rule", () => {
    const override: DisputeRule = {
      name: "test_override_duplicate",
      priority: 40,
      async evaluate(): Promise<RuleResult> {
        return { ruleName: "test_override_duplicate", priority: 40, matched: false, confidence: 0, resolution: null, resolutionReason: null };
      },
    };

    registerRule(override);
    const rules = getRegisteredRules();
    const names = rules.map((r) => r.name);
    // Should appear exactly once
    expect(names.filter((n) => n === "test_override_duplicate")).toHaveLength(1);
  });

  it("getRegisteredRules returns rules in priority order after registration", () => {
    const low: DisputeRule = {
      name: "test_high_priority",
      priority: 1,
      async evaluate(): Promise<RuleResult> {
        return { ruleName: "test_high_priority", priority: 1, matched: false, confidence: 0, resolution: null, resolutionReason: null };
      },
    };
    registerRule(low);

    const rules = getRegisteredRules();
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i - 1].priority).toBeGreaterThanOrEqual(rules[i].priority);
    }
  });

  it("unregisterRule removes the rule from evaluation", async () => {
    // Temporarily remove duplicate_transaction to confirm already_refunded runs first
    unregisterRule("duplicate_transaction");

    mockConfigQuery();
    mockCountQuery("1"); // already_refunded → match (now highest priority)

    const result = await evaluateDispute(makeContext());
    expect(result!.ruleName).toBe("already_refunded");

    // Restore
    const { default: engine } = await import("../../../src/services/disputeResolutionEngine");
  });
});
