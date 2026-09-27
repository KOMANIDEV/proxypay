/**
 * Automated Dispute Resolution Rules Engine
 *
 * Evaluates open disputes against configurable rules and automatically
 * resolves those that qualify. Covers:
 *   - Duplicate transaction detection
 *   - Amount mismatch within tolerance
 *   - Timeout resolution (provider did not respond)
 *   - Refund already processed
 *
 * Rules are evaluated in priority order (highest number = highest priority).
 * The engine stops at the FIRST matching rule that meets the confidence
 * threshold — later rules are never evaluated once a match is found.
 */

import { pool } from "../config/database";
import logger from "../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DisputeContext {
  disputeId: string;
  transactionId: string;
  reason: string;
  category: string | null;
  transactionStatus: string;
  transactionAmount: number;
  transactionCurrency: string;
  transactionCreatedAt: Date;
  providerReference: string | null;
  merchantId: string;
}

export interface RuleResult {
  ruleName: string;
  /** Priority of the rule that produced this result. Higher = evaluated first. */
  priority: number;
  matched: boolean;
  confidence: number;
  resolution: "resolved" | "rejected" | null;
  resolutionReason: string | null;
  metadata?: Record<string, unknown>;
}

export interface AutoResolutionConfig {
  /** Minimum confidence to auto-resolve (0–1). Default 0.85. */
  confidenceThreshold: number;
  /** Maximum transaction age in hours for auto-resolution. Default 72. */
  maxTransactionAgeHours: number;
  /** Amount mismatch tolerance percentage. Default 0.5%. */
  amountMismatchTolerancePct: number;
  /** Timeout threshold in seconds. Default 300 (5 min). */
  timeoutThresholdSeconds: number;
}

/**
 * A dispute resolution rule with its priority.
 *
 * `priority` is a positive integer. Rules are evaluated in descending order
 * (highest priority first). When two rules share the same priority value the
 * order between them is deterministic but unspecified — give every rule a
 * unique priority to make the ordering explicit.
 */
export interface DisputeRule {
  name: string;
  /**
   * Evaluation order. Higher numbers run first.
   * Built-in defaults (lowest → highest):
   *   amount_mismatch       10
   *   provider_timeout      20
   *   already_refunded      30
   *   duplicate_transaction 40
   */
  priority: number;
  evaluate: (ctx: DisputeContext, config: AutoResolutionConfig) => Promise<RuleResult>;
}

const DEFAULT_CONFIG: AutoResolutionConfig = {
  confidenceThreshold: 0.85,
  maxTransactionAgeHours: 72,
  amountMismatchTolerancePct: 0.5,
  timeoutThresholdSeconds: 300,
};

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS = 60_000;
let configCache: { config: AutoResolutionConfig; expiresAt: number } | null = null;

async function loadConfig(): Promise<AutoResolutionConfig> {
  if (configCache && Date.now() < configCache.expiresAt) {
    return configCache.config;
  }

  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM dispute_resolution_config
       WHERE key IN ('confidence_threshold', 'max_transaction_age_hours',
                     'amount_mismatch_tolerance_pct', 'timeout_threshold_seconds')`,
    );

    const map = new Map(rows.map((r) => [r.key, r.value]));
    const config: AutoResolutionConfig = {
      confidenceThreshold: parseFloat(map.get("confidence_threshold") ?? String(DEFAULT_CONFIG.confidenceThreshold)),
      maxTransactionAgeHours: parseInt(map.get("max_transaction_age_hours") ?? String(DEFAULT_CONFIG.maxTransactionAgeHours), 10),
      amountMismatchTolerancePct: parseFloat(map.get("amount_mismatch_tolerance_pct") ?? String(DEFAULT_CONFIG.amountMismatchTolerancePct)),
      timeoutThresholdSeconds: parseInt(map.get("timeout_threshold_seconds") ?? String(DEFAULT_CONFIG.timeoutThresholdSeconds), 10),
    };

    configCache = { config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
    return config;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Update auto-resolution configuration (admin API).
 */
export async function updateConfig(updates: Partial<AutoResolutionConfig>): Promise<void> {
  const entries: [string, string][] = [];
  if (updates.confidenceThreshold !== undefined) entries.push(["confidence_threshold", String(updates.confidenceThreshold)]);
  if (updates.maxTransactionAgeHours !== undefined) entries.push(["max_transaction_age_hours", String(updates.maxTransactionAgeHours)]);
  if (updates.amountMismatchTolerancePct !== undefined) entries.push(["amount_mismatch_tolerance_pct", String(updates.amountMismatchTolerancePct)]);
  if (updates.timeoutThresholdSeconds !== undefined) entries.push(["timeout_threshold_seconds", String(updates.timeoutThresholdSeconds)]);

  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO dispute_resolution_config (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }

  configCache = null;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/**
 * Rule: Duplicate Transaction (priority 40 — highest built-in priority)
 * Checks if another transaction exists with the same amount, phone, and provider
 * within a short time window. A clear-cut duplicate is the strongest signal, so
 * this rule runs first and wins immediately if it matches.
 */
const ruleDuplicateTransaction: DisputeRule = {
  name: "duplicate_transaction",
  priority: 40,
  async evaluate(ctx, _config) {
    try {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM transactions
         WHERE phone_number = (SELECT phone_number FROM transactions WHERE id = $1)
           AND amount = $2
           AND provider = (SELECT provider FROM transactions WHERE id = $1)
           AND id != $1
           AND created_at BETWEEN $3 AND $4
           AND status = 'completed'`,
        [
          ctx.transactionId,
          ctx.transactionAmount,
          new Date(ctx.transactionCreatedAt.getTime() - 60_000),
          new Date(ctx.transactionCreatedAt.getTime() + 60_000),
        ],
      );

      const duplicateCount = parseInt(rows[0]?.count ?? "0", 10);
      const confidence = duplicateCount > 0 ? 0.95 : 0;

      return {
        ruleName: "duplicate_transaction",
        priority: ruleDuplicateTransaction.priority,
        matched: duplicateCount > 0,
        confidence,
        resolution: duplicateCount > 0 ? "resolved" : null,
        resolutionReason: duplicateCount > 0
          ? `Duplicate transaction detected (${duplicateCount} matching transaction(s) found within 1-minute window)`
          : null,
        metadata: { duplicateCount },
      };
    } catch (error) {
      logger.error({ error, disputeId: ctx.disputeId }, "ruleDuplicateTransaction failed");
      return { ruleName: "duplicate_transaction", priority: ruleDuplicateTransaction.priority, matched: false, confidence: 0, resolution: null, resolutionReason: null };
    }
  },
};

/**
 * Rule: Already Refunded (priority 30)
 * If a refund or reversal already exists for this transaction, auto-resolve.
 * Checked before timeout so a dispute on a refunded-but-still-pending
 * transaction resolves cleanly instead of being mis-labelled a timeout.
 */
const ruleAlreadyRefunded: DisputeRule = {
  name: "already_refunded",
  priority: 30,
  async evaluate(ctx, _config) {
    try {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM transactions
         WHERE reference_id = $1
           AND status IN ('completed', 'pending')
           AND type = 'refund'`,
        [ctx.transactionId],
      );

      const refundCount = parseInt(rows[0]?.count ?? "0", 10);

      return {
        ruleName: "already_refunded",
        priority: ruleAlreadyRefunded.priority,
        matched: refundCount > 0,
        confidence: refundCount > 0 ? 0.95 : 0,
        resolution: refundCount > 0 ? "resolved" : null,
        resolutionReason: refundCount > 0
          ? "A refund has already been processed for this transaction"
          : null,
        metadata: { refundCount },
      };
    } catch (error) {
      logger.error({ error, disputeId: ctx.disputeId }, "ruleAlreadyRefunded failed");
      return { ruleName: "already_refunded", priority: ruleAlreadyRefunded.priority, matched: false, confidence: 0, resolution: null, resolutionReason: null };
    }
  },
};

/**
 * Rule: Provider Timeout (priority 20)
 * If the transaction is stuck in pending and the provider did not respond
 * within the timeout threshold, auto-reject the dispute (refund will be
 * handled by the timeout job).
 */
const ruleProviderTimeout: DisputeRule = {
  name: "provider_timeout",
  priority: 20,
  async evaluate(ctx, config) {
    if (ctx.transactionStatus !== "pending") {
      return { ruleName: "provider_timeout", priority: ruleProviderTimeout.priority, matched: false, confidence: 0, resolution: null, resolutionReason: null };
    }

    const ageMs = Date.now() - ctx.transactionCreatedAt.getTime();
    const ageSeconds = ageMs / 1000;

    if (ageSeconds < config.timeoutThresholdSeconds) {
      return { ruleName: "provider_timeout", priority: ruleProviderTimeout.priority, matched: false, confidence: 0, resolution: null, resolutionReason: null };
    }

    return {
      ruleName: "provider_timeout",
      priority: ruleProviderTimeout.priority,
      matched: true,
      confidence: 0.9,
      resolution: "rejected",
      resolutionReason: `Transaction is pending for ${Math.round(ageSeconds)}s (threshold: ${config.timeoutThresholdSeconds}s). Automatic timeout handling will process the refund.`,
      metadata: { ageSeconds, threshold: config.timeoutThresholdSeconds },
    };
  },
};

/**
 * Rule: Amount Mismatch (priority 10 — lowest built-in priority)
 * If the dispute reason mentions amount and the transaction completed
 * successfully, flag for manual review (confidence below auto-resolve threshold).
 * This rule runs last because it only produces low-confidence results.
 */
const ruleAmountMismatch: DisputeRule = {
  name: "amount_mismatch",
  priority: 10,
  async evaluate(ctx, _config) {
    const reasonLower = ctx.reason.toLowerCase();
    const mentionsAmount =
      reasonLower.includes("amount") ||
      reasonLower.includes("overcharge") ||
      reasonLower.includes("wrong amount") ||
      reasonLower.includes("incorrect amount");

    if (!mentionsAmount) {
      return { ruleName: "amount_mismatch", priority: ruleAmountMismatch.priority, matched: false, confidence: 0, resolution: null, resolutionReason: null };
    }

    // If the transaction completed successfully with the correct amount,
    // and the dispute is about amount, it's likely a misunderstanding
    if (ctx.transactionStatus === "completed") {
      return {
        ruleName: "amount_mismatch",
        priority: ruleAmountMismatch.priority,
        matched: true,
        confidence: 0.7,
        resolution: null,
        resolutionReason: null,
        metadata: { note: "Transaction completed successfully — manual review recommended for amount disputes" },
      };
    }

    return { ruleName: "amount_mismatch", priority: ruleAmountMismatch.priority, matched: false, confidence: 0, resolution: null, resolutionReason: null };
  },
};

// ─── Engine ───────────────────────────────────────────────────────────────────

/**
 * The ordered set of built-in dispute resolution rules.
 *
 * Rules are sorted once at module load time (highest priority first) so that
 * `evaluateDispute` can iterate in the correct order without re-sorting on
 * every call. Custom rules registered via `registerRule` are merged into this
 * list in the same sorted order.
 */
const BUILT_IN_RULES: DisputeRule[] = [
  ruleDuplicateTransaction,
  ruleAlreadyRefunded,
  ruleProviderTimeout,
  ruleAmountMismatch,
];

/**
 * Registered rules sorted by priority descending (highest first).
 * Mutated only by `registerRule` / `unregisterRule`.
 */
let registeredRules: DisputeRule[] = [...BUILT_IN_RULES].sort(
  (a, b) => b.priority - a.priority,
);

/**
 * Register an additional rule (or override a built-in by name).
 * Existing rules with the same name are replaced.
 */
export function registerRule(rule: DisputeRule): void {
  registeredRules = registeredRules.filter((r) => r.name !== rule.name);
  registeredRules.push(rule);
  registeredRules.sort((a, b) => b.priority - a.priority);
}

/**
 * Remove a previously registered rule by name.
 */
export function unregisterRule(name: string): void {
  registeredRules = registeredRules.filter((r) => r.name !== name);
}

/**
 * Return a snapshot of the currently registered rules in evaluation order
 * (highest priority first).
 */
export function getRegisteredRules(): ReadonlyArray<{ name: string; priority: number }> {
  return registeredRules.map(({ name, priority }) => ({ name, priority }));
}

/**
 * Evaluate rules against a dispute context in priority order.
 *
 * Rules run sequentially from highest priority to lowest.  The first rule
 * that both matches AND has a resolution AND meets the confidence threshold
 * is returned immediately — no further rules are evaluated.
 *
 * Returns `null` when no rule qualifies for automatic resolution.
 */
export async function evaluateDispute(
  ctx: DisputeContext,
): Promise<RuleResult | null> {
  const config = await loadConfig();

  for (const rule of registeredRules) {
    const result = await rule.evaluate(ctx, config);

    if (!result.matched || result.resolution === null) {
      // Rule did not match or produced no actionable resolution — try next.
      continue;
    }

    if (result.confidence < config.confidenceThreshold) {
      // Rule matched but confidence is too low — try next lower-priority rule.
      continue;
    }

    // First qualifying match: return immediately (stop processing).
    logger.debug(
      {
        disputeId: ctx.disputeId,
        rule: result.ruleName,
        priority: result.priority,
        confidence: result.confidence,
      },
      "Dispute rule matched — stopping rule evaluation",
    );
    return result;
  }

  return null;
}

/**
 * Process a single dispute: evaluate rules and auto-resolve if applicable.
 * Returns the resolution result or null if manual review is needed.
 */
export async function processDispute(ctx: DisputeContext): Promise<{
  autoResolved: boolean;
  result: RuleResult | null;
}> {
  const result = await evaluateDispute(ctx);

  if (!result || !result.resolution) {
    return { autoResolved: false, result };
  }

  // Pre-resolution notification to merchant
  try {
    await pool.query(
      `INSERT INTO dispute_resolution_notifications (dispute_id, merchant_id, rule_name, resolution, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ctx.disputeId,
        ctx.merchantId,
        result.ruleName,
        result.resolution,
        result.resolutionReason,
      ],
    );
  } catch (error) {
    logger.warn({ error, disputeId: ctx.disputeId }, "Failed to send pre-resolution notification");
  }

  // Apply resolution
  const newStatus = result.resolution === "resolved" ? "resolved" : "rejected";
  await pool.query(
    `UPDATE disputes
     SET status = $1,
         resolution = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [newStatus, result.resolutionReason, ctx.disputeId],
  );

  // Log the auto-resolution including the rule priority that triggered it
  await pool.query(
    `INSERT INTO dispute_resolution_log (dispute_id, rule_name, rule_priority, confidence, resolution, auto_resolved)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [ctx.disputeId, result.ruleName, result.priority, result.confidence, result.resolution],
  );

  logger.info(
    {
      disputeId: ctx.disputeId,
      rule: result.ruleName,
      priority: result.priority,
      confidence: result.confidence,
      resolution: result.resolution,
    },
    "Dispute auto-resolved",
  );

  return { autoResolved: true, result };
}
