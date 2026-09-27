/**
 * Circuit breaker for outbound webhook delivery (#573)
 *
 * `WebhookService` already retries with exponential backoff, but backoff alone
 * does not stop the bleeding: once a destination starts refusing every delivery,
 * every transaction in the system keeps spending `maxAttempts` round trips and
 * `maxDelayMs` of sleep per event, for an endpoint that is already known to be
 * dead. A dead webhook that is never retried again is a dead webhook that never
 * comes back either — and the endpoint may well have been fixed in the meantime.
 *
 * This is the standard three-state breaker:
 *
 *   closed     → traffic flows; consecutive failures are counted
 *   open       → traffic is refused immediately, with no network call at all
 *   half-open  → one trial request is let through to test the water
 *
 * The half-open state is the part that matters and the part that is usually
 * missing. Without it, a breaker that trips stays tripped forever and the only
 * recovery is a human noticing and restarting something. Here the breaker moves
 * itself from open to half-open after `recoveryAfterMs` (24 hours by default), so
 * a destination that was down overnight is given exactly one chance to prove
 * itself on the first transaction of the morning. One request, not a flood: if
 * that trial fails the breaker re-opens for another full period.
 *
 * State is per-destination-URL rather than global, because the failure of one
 * merchant's endpoint says nothing about another's. Today the service is
 * configured with a single `WEBHOOK_URL`, but keying on the URL costs nothing
 * and means per-merchant routing needs no rewrite here.
 *
 * Why this is not `src/utils/circuitBreaker.ts`
 * ------------------------------------------------
 * That module wraps a single operation in an `opossum` breaker keyed by
 * `provider:operation`, configured from `providerSettingsService`, and reported
 * through the `provider_circuit_breaker_*` metrics. A merchant's webhook
 * endpoint is not a provider, and its configuration does not live in provider
 * settings, so reusing it would mean inventing a fake "webhook" provider to
 * satisfy the key space and would file webhook state alongside provider health.
 *
 * The integration shape differs too, which is the real obstacle. `opossum` wants
 * to own the whole call: execute it, classify the result, and run a fallback if
 * it rejects. Here the breaker has to be consulted *before* an existing
 * multi-attempt retry loop and told the verdict *after* the loop gives up — the
 * loop is the thing being protected, not the thing the breaker is wrapping.
 * Modelling that through `executeWithCircuitBreaker` would mean either running
 * the retries inside the fallback (so a failure looked like a successful
 * fallback) or duplicating the retry loop to give the breaker something to own.
 *
 * The state machine itself is the conventional one and is small enough to read
 * in a sitting, which is the property worth having in a component whose failure
 * mode is "stop delivering webhooks".
 *
 * Breaker state is deliberately in-process. It is a rate-limiting decision
 * about the last few minutes of traffic, not a record that must survive a
 * restart: after a deploy, the first few deliveries re-probe the destination,
 * which is exactly the half-open behaviour we want anyway.
 */

import { webhookCircuitBreakerState, webhookCircuitBreakerTransitionsTotal } from "../utils/metrics";
import type { WebhookLogger } from "./webhook";

export type CircuitState = "closed" | "open" | "half_open";

/** Why the breaker moved. Recorded as a metric label and a log field. */
export type CircuitTransitionReason =
  | "failure_threshold"
  | "recovery_probe"
  | "probe_succeeded"
  | "probe_failed"
  | "manual_reset"
  | "half_open_inflight";

export interface CircuitBreakerSnapshot {
  url: string;
  state: CircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  /** Consecutive failures needed to trip. */
  failureThreshold: number;
  /** How long the breaker stays open before allowing a probe. */
  recoveryAfterMs: number;
  openedAt: string | null;
  /** When the breaker will next allow a trial request, if open. */
  nextProbeAt: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Set while a half-open probe is in flight, to keep the gate to one request. */
  probeInFlight: boolean;
}

interface BreakerRecord {
  state: CircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  probeInFlight: boolean;
}

export interface CircuitBreakerOptions {
  /**
   * Consecutive failed deliveries before the breaker opens.
   * @default 10
   */
  failureThreshold?: number;
  /**
   * How long the breaker stays open before permitting a half-open probe.
   * @default 24 hours, per the recovery window in #573.
   */
  recoveryAfterMs?: number;
  now?: () => number;
  logger?: WebhookLogger;
}

const DEFAULT_FAILURE_THRESHOLD = 10;
const DEFAULT_RECOVERY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Sentinel returned by `acquirePermission` to mean "call the circuit". */
export const CIRCUIT_CLOSED = "closed" as const;
/** Do not call the circuit. */
export const CIRCUIT_OPEN = "open" as const;
/** Call the circuit, but only this one caller. */
export const CIRCUIT_HALF_OPEN = "half_open" as const;

export type CircuitPermission = typeof CIRCUIT_CLOSED | typeof CIRCUIT_OPEN | typeof CIRCUIT_HALF_OPEN;

const noopLogger: WebhookLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export class WebhookCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly recoveryAfterMs: number;
  private readonly now: () => number;
  private readonly logger: WebhookLogger;
  private readonly breakers = new Map<string, BreakerRecord>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = positiveInt(
      options.failureThreshold,
      positiveInt(
        parseInt(process.env.WEBHOOK_CIRCUIT_FAILURE_THRESHOLD || "", 10),
        DEFAULT_FAILURE_THRESHOLD,
      ),
    );
    this.recoveryAfterMs = positiveInt(
      options.recoveryAfterMs,
      positiveInt(
        parseInt(process.env.WEBHOOK_CIRCUIT_RECOVERY_MS || "", 10),
        DEFAULT_RECOVERY_AFTER_MS,
      ),
    );
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? noopLogger;
  }

  private record(url: string): BreakerRecord {
    let entry = this.breakers.get(url);
    if (!entry) {
      entry = {
        state: "closed",
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        openedAt: null,
        lastFailureAt: null,
        lastSuccessAt: null,
        lastError: null,
        probeInFlight: false,
      };
      this.breakers.set(url, entry);
    }
    return entry;
  }

  /**
   * Publish the current state to the gauge.
   *
   * Every state is written every time, not just the active one. Setting only
   * the current state would leave a stale `1` behind for the state just left
   * behind, and a dashboard would show `open` and `closed` at the same time —
   * which is precisely the moment a human looks at this metric to decide
   * whether the breaker is hurting them.
   *
   * Deliberately unlabelled by URL. With a single configured `WEBHOOK_URL` the
   * series count is three either way, and per-destination detail lives in the
   * admin snapshot instead, where a human is actually reading it. Adding a `url`
   * label later would be the right move if destinations ever become
   * per-merchant and the cardinality stops being bounded by configuration.
   */
  private publishState(state: CircuitState): void {
    for (const candidate of ["closed", "open", "half_open"] as CircuitState[]) {
      webhookCircuitBreakerState.set({ state: candidate }, candidate === state ? 1 : 0);
    }
  }

  private transition(
    entry: BreakerRecord,
    to: CircuitState,
    reason: CircuitTransitionReason,
    url: string,
  ): void {
    const from = entry.state;
    if (from === to) return;

    entry.state = to;
    if (to === "open") {
      entry.openedAt = this.now();
    } else if (to === "closed") {
      entry.consecutiveFailures = 0;
      entry.openedAt = null;
      entry.probeInFlight = false;
    }

    this.publishState(to);

    webhookCircuitBreakerTransitionsTotal.inc({ from, to, reason });
    this.logger.warn(
      `[webhook-circuit] ${from} -> ${to} reason=${reason} ` +
        `failures=${entry.consecutiveFailures}/${this.failureThreshold} ` +
        `recoveryAfterMs=${this.recoveryAfterMs}`,
    );
  }

  /**
   * Move an expired `open` breaker to `half_open`.
   *
   * Called on the read path rather than by a timer: a breaker nobody is talking
   * to has no reason to change state, and this keeps the class free of
   * background work that would need shutting down in tests.
   */
  private maybeHalfOpen(entry: BreakerRecord, url: string): void {
    if (entry.state !== "open" || entry.openedAt === null) return;
    if (this.now() - entry.openedAt < this.recoveryAfterMs) return;
    this.transition(entry, "half_open", "recovery_probe", url);
  }

  /**
   * Ask permission to make a delivery to `url`.
   *
   * Returns `closed` for normal traffic, `half_open` for the single trial
   * request after a cooldown, and `open` when the caller must not touch the
   * network at all.
   */
  acquirePermission(url: string): CircuitPermission {
    const entry = this.record(url);
    this.maybeHalfOpen(entry, url);

    if (entry.state === "open") {
      this.publishState(entry.state);
      return CIRCUIT_OPEN;
    }

    if (entry.state === "half_open") {
      if (entry.probeInFlight) {
        // A probe is already out. Everything else keeps waiting rather than
        // joining it, so a recovering endpoint sees one request, not a herd.
        this.publishState(entry.state);
        return CIRCUIT_OPEN;
      }
      entry.probeInFlight = true;
      this.publishState(entry.state);
      this.logger.log(
        `[webhook-circuit] half-open probe admitted url=${url} ` +
          `consecutiveFailures=${entry.consecutiveFailures}`,
      );
      return CIRCUIT_HALF_OPEN;
    }

    this.publishState(entry.state);
    return CIRCUIT_CLOSED;
  }

  /** Record a successful delivery. */
  recordSuccess(url: string): void {
    const entry = this.record(url);
    entry.totalSuccesses += 1;
    entry.lastSuccessAt = this.now();
    entry.lastError = null;

    if (entry.state === "half_open") {
      // The whole point of the probe: the endpoint answered, so close it and
      // forgive the failure history that opened it.
      this.transition(entry, "closed", "probe_succeeded", url);
      this.logger.log(
        `[webhook-circuit] closed after successful probe url=${url}`,
      );
      return;
    }

    entry.consecutiveFailures = 0;
  }

  /**
   * Record a failed delivery.
   *
   * @param url       Destination that failed.
   * @param error     Last error, kept for the admin snapshot.
   * @param wasProbe  True when the caller knows this failure was the half-open
   *                  trial request. The breaker's own state is the authority
   *                  here — a probe that fails re-opens immediately rather than
   *                  waiting to reach the threshold again — and this flag is the
   *                  cross-check for the case where the two disagree.
   */
  recordFailure(url: string, error?: string | null, wasProbe = false): void {
    const entry = this.record(url);
    entry.totalFailures += 1;
    entry.consecutiveFailures += 1;
    entry.lastFailureAt = this.now();
    entry.lastError = error ?? null;

    if (entry.state === "half_open") {
      entry.probeInFlight = false;
      this.transition(entry, "open", "probe_failed", url);
      return;
    }

    if (entry.state === "closed" && entry.consecutiveFailures >= this.failureThreshold) {
      this.transition(entry, "open", "failure_threshold", url);
      return;
    }

    // A probe flag with no half-open state means something reset the breaker
    // while the trial request was still in flight. Re-opening on that single
    // failure would be a surprise, so the threshold still has to be met.
    if (wasProbe && entry.state === "open" && entry.consecutiveFailures >= this.failureThreshold) {
      this.transition(entry, "open", "probe_failed", url);
    }
  }

  /**
   * Force a breaker back to `closed`, discarding its failure history.
   *
   * This is the manual escape hatch for #573: an operator who knows the
   * destination has been fixed should not have to wait out the 24-hour window.
   */
  reset(url: string): CircuitBreakerSnapshot {
    const entry = this.record(url);
    const was = entry.state;

    entry.consecutiveFailures = 0;
    entry.openedAt = null;
    entry.probeInFlight = false;
    entry.lastError = null;
    this.transition(entry, "closed", "manual_reset", url);

    // `transition` is a no-op when the state already matched, so log the reset
    // either way: an operator who pressed the button deserves confirmation that
    // it did something, and "cleared the failure count" is that something.
    this.logger.log(
      `[webhook-circuit] manual reset url=${url} previousState=${was} ` +
        `consecutiveFailures=0 totalFailures=${entry.totalFailures}`,
    );
    return this.snapshot(url);
  }

  /** Current state of one destination. */
  snapshot(url: string): CircuitBreakerSnapshot {
    const entry = this.record(url);
    const openedAt = entry.openedAt;
    return {
      url,
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      totalFailures: entry.totalFailures,
      totalSuccesses: entry.totalSuccesses,
      failureThreshold: this.failureThreshold,
      recoveryAfterMs: this.recoveryAfterMs,
      openedAt: openedAt === null ? null : new Date(openedAt).toISOString(),
      nextProbeAt:
        entry.state === "open" && openedAt !== null
          ? new Date(openedAt + this.recoveryAfterMs).toISOString()
          : null,
      lastFailureAt:
        entry.lastFailureAt === null
          ? null
          : new Date(entry.lastFailureAt).toISOString(),
      lastSuccessAt:
        entry.lastSuccessAt === null
          ? null
          : new Date(entry.lastSuccessAt).toISOString(),
      lastError: entry.lastError,
      probeInFlight: entry.probeInFlight,
    };
  }

  /** Every destination the process has talked to, for the admin endpoint. */
  listSnapshots(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.keys())
      .map((url) => this.snapshot(url))
      .sort((a, b) => a.url.localeCompare(b.url));
  }

  /** Test seam: drop all state. */
  clear(): void {
    this.breakers.clear();
  }
}

/**
 * Process-wide breaker.
 *
 * The breaker has to be shared: two independent instances would each count
 * their own failures and neither would reach the threshold, so a destination
 * could fail indefinitely without either breaker noticing.
 */
let sharedBreaker: WebhookCircuitBreaker | null = null;

export function getWebhookCircuitBreaker(): WebhookCircuitBreaker {
  if (!sharedBreaker) {
    sharedBreaker = new WebhookCircuitBreaker();
  }
  return sharedBreaker;
}

/** Test seam: replace or drop the shared breaker. */
export function setWebhookCircuitBreaker(
  breaker: WebhookCircuitBreaker | null,
): void {
  sharedBreaker = breaker;
}
