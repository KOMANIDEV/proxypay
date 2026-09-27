/**
 * Circuit breaker lifecycle tests (#573)
 *
 * The behaviour under test is the part that is easy to get wrong and expensive
 * to get wrong: once a destination trips, does it ever come back without a
 * human, and does it come back *gradually* rather than all at once.
 *
 * NOT EXECUTED in this change and not wired into CI. Included as executable
 * specification.
 */

import {
  CIRCUIT_CLOSED,
  CIRCUIT_HALF_OPEN,
  CIRCUIT_OPEN,
  WebhookCircuitBreaker,
  getWebhookCircuitBreaker,
  setWebhookCircuitBreaker,
  type WebhookCircuitBreaker as Breaker,
} from "../webhookCircuitBreaker";

jest.mock("../../utils/metrics", () => ({
  webhookCircuitBreakerTransitionsTotal: { inc: jest.fn() },
  webhookCircuitBreakerState: { set: jest.fn() },
  webhookCircuitBreakerSkippedTotal: { inc: jest.fn() },
}));

const HOUR = 60 * 60 * 1000;
const URL_A = "https://merchant-a.example/hooks";
const URL_B = "https://merchant-b.example/hooks";

/** A logger that records, so assertions can be made about what was reported. */
function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    log: (...args: unknown[]) => lines.push(args.join(" ")),
    warn: (...args: unknown[]) => lines.push(args.join(" ")),
    error: (...args: unknown[]) => lines.push(args.join(" ")),
  };
}

describe("WebhookCircuitBreaker", () => {
  let now: number;
  let breaker: Breaker;
  let logger: ReturnType<typeof recordingLogger>;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 1_700_000_000_000;
    logger = recordingLogger();
    breaker = new WebhookCircuitBreaker({
      failureThreshold: 3,
      recoveryAfterMs: 24 * HOUR,
      now: () => now,
      logger,
    });
  });

  afterEach(() => {
    setWebhookCircuitBreaker(null);
  });

  describe("closed state", () => {
    it("admits traffic while failures are below the threshold", () => {
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_CLOSED);
      breaker.recordFailure(URL_A, "HTTP 500");
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_CLOSED);
      breaker.recordFailure(URL_A, "HTTP 500");
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_CLOSED);
      expect(breaker.snapshot(URL_A).state).toBe("closed");
    });

    it("opens on the failure that reaches the threshold, not before", () => {
      breaker.recordFailure(URL_A, "HTTP 500");
      breaker.recordFailure(URL_A, "HTTP 500");
      expect(breaker.snapshot(URL_A).state).toBe("closed");

      breaker.recordFailure(URL_A, "HTTP 500");
      expect(breaker.snapshot(URL_A).state).toBe("open");
    });

    it("resets the consecutive count on success, so scattered failures never trip it", () => {
      breaker.recordFailure(URL_A, "HTTP 500");
      breaker.recordFailure(URL_A, "HTTP 500");
      breaker.recordSuccess(URL_A);
      breaker.recordFailure(URL_A, "HTTP 500");
      breaker.recordFailure(URL_A, "HTTP 500");

      expect(breaker.snapshot(URL_A).consecutiveFailures).toBe(2);
      expect(breaker.snapshot(URL_A).state).toBe("closed");
    });

    it("keeps lifetime totals across a reset of the consecutive count", () => {
      breaker.recordFailure(URL_A, "a");
      breaker.recordSuccess(URL_A);
      breaker.recordFailure(URL_A, "b");

      const snapshot = breaker.snapshot(URL_A);
      expect(snapshot.totalFailures).toBe(2);
      expect(snapshot.totalSuccesses).toBe(1);
      expect(snapshot.consecutiveFailures).toBe(1);
    });
  });

  describe("open state", () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "HTTP 500");
    });

    it("refuses traffic without any network call", () => {
      expect(breaker.snapshot(URL_A).state).toBe("open");
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_OPEN);
      // A refused request must not count as a failure, or the failure count
      // would climb forever while the endpoint is never even contacted.
      expect(breaker.snapshot(URL_A).consecutiveFailures).toBe(3);
    });

    it("stays open until the recovery window has fully elapsed", () => {
      now += 24 * HOUR - 1;
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_OPEN);
      expect(breaker.snapshot(URL_A).state).toBe("open");
    });

    it("reports when the next probe is due", () => {
      const openedAt = now;
      now += HOUR;
      expect(breaker.snapshot(URL_A).nextProbeAt).toBe(
        new Date(openedAt + 24 * HOUR).toISOString(),
      );
    });

    it("logs the transition with both states and the reason", () => {
      const fresh = new WebhookCircuitBreaker({
        failureThreshold: 1,
        now: () => now,
        logger,
      });
      fresh.recordFailure(URL_A, "HTTP 500");

      expect(logger.lines.join("\n")).toContain("closed -> open");
      expect(logger.lines.join("\n")).toContain("reason=failure_threshold");
    });
  });

  describe("half-open recovery", () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "HTTP 500");
      now += 24 * HOUR;
    });

    it("admits exactly one probe after the recovery window", () => {
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_HALF_OPEN);
      // Everything else keeps waiting. A recovering endpoint must not be hit
      // by the entire backlog at once.
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_OPEN);
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_OPEN);
    });

    it("closes on a successful probe and forgives the failure history", () => {
      breaker.acquirePermission(URL_A);
      breaker.recordSuccess(URL_A);

      const snapshot = breaker.snapshot(URL_A);
      expect(snapshot.state).toBe("closed");
      expect(snapshot.consecutiveFailures).toBe(0);
      expect(snapshot.probeInFlight).toBe(false);
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_CLOSED);
    });

    it("re-opens immediately when the probe fails, without waiting for the threshold", () => {
      breaker.acquirePermission(URL_A);
      breaker.recordFailure(URL_A, "HTTP 503", true);

      expect(breaker.snapshot(URL_A).state).toBe("open");
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_OPEN);
    });

    it("gives the destination a full fresh window after a failed probe", () => {
      breaker.acquirePermission(URL_A);
      breaker.recordFailure(URL_A, "HTTP 503", true);

      now += 24 * HOUR - 1;
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_OPEN);

      now += 1;
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_HALF_OPEN);
    });

    it("releases the in-flight slot when a probe fails, so the next window is reachable", () => {
      breaker.acquirePermission(URL_A);
      breaker.recordFailure(URL_A, "HTTP 503", true);
      expect(breaker.snapshot(URL_A).probeInFlight).toBe(false);
    });
  });

  describe("manual reset", () => {
    it("closes an open breaker and clears the failure history", () => {
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "HTTP 500");
      expect(breaker.snapshot(URL_A).state).toBe("open");

      const snapshot = breaker.reset(URL_A);
      expect(snapshot.state).toBe("closed");
      expect(snapshot.consecutiveFailures).toBe(0);
      expect(snapshot.lastError).toBeNull();
      expect(breaker.acquirePermission(URL_A)).toBe(CIRCUIT_CLOSED);
    });

    it("shortens the wait: the next failure can trip it again immediately", () => {
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "HTTP 500");
      breaker.reset(URL_A);
      // No 24-hour wait this time: a reset means "start counting again now".
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "HTTP 500");
      expect(breaker.snapshot(URL_A).state).toBe("open");
    });

    it("logs the reset even when the breaker was already closed", () => {
      breaker.reset(URL_A);
      expect(logger.lines.join("\n")).toContain("manual reset");
    });

    it("is harmless for a destination that has never been used", () => {
      const snapshot = breaker.reset(URL_B);
      expect(snapshot.state).toBe("closed");
      expect(snapshot.totalFailures).toBe(0);
    });
  });

  describe("isolation between destinations", () => {
    it("does not let one dead endpoint affect another", () => {
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "HTTP 500");

      expect(breaker.snapshot(URL_A).state).toBe("open");
      expect(breaker.snapshot(URL_B).state).toBe("closed");
      expect(breaker.acquirePermission(URL_B)).toBe(CIRCUIT_CLOSED);
    });

    it("resets only the destination asked for", () => {
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "x");
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_B, "x");

      breaker.reset(URL_A);
      expect(breaker.snapshot(URL_A).state).toBe("closed");
      expect(breaker.snapshot(URL_B).state).toBe("open");
    });

    it("lists every destination it has seen, in a stable order", () => {
      breaker.acquirePermission(URL_B);
      breaker.acquirePermission(URL_A);

      expect(breaker.listSnapshots().map((s) => s.url)).toEqual([URL_A, URL_B]);
    });
  });

  describe("metrics", () => {
    it("counts a transition with from, to and reason labels", () => {
      const metrics = require("../../utils/metrics");
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "x");

      expect(metrics.webhookCircuitBreakerTransitionsTotal.inc).toHaveBeenCalledWith({
        from: "closed",
        to: "open",
        reason: "failure_threshold",
      });
    });

    it("labels the recovery transition distinctly from a threshold trip", () => {
      const metrics = require("../../utils/metrics");
      for (let i = 0; i < 3; i += 1) breaker.recordFailure(URL_A, "x");
      now += 24 * HOUR;
      breaker.acquirePermission(URL_A);

      expect(metrics.webhookCircuitBreakerTransitionsTotal.inc).toHaveBeenCalledWith({
        from: "open",
        to: "half_open",
        reason: "recovery_probe",
      });
    });

    it("does not count a no-op transition", () => {
      const metrics = require("../../utils/metrics");
      breaker.recordSuccess(URL_A);
      expect(metrics.webhookCircuitBreakerTransitionsTotal.inc).not.toHaveBeenCalled();
    });
  });

  describe("configuration", () => {
    it("falls back to defaults for nonsensical thresholds", () => {
      const lenient = new WebhookCircuitBreaker({
        failureThreshold: 0,
        recoveryAfterMs: -1,
        now: () => now,
      });
      expect(lenient.snapshot(URL_A).failureThreshold).toBe(10);
      expect(lenient.snapshot(URL_A).recoveryAfterMs).toBe(24 * HOUR);
    });

    it("reports its own thresholds in the snapshot", () => {
      const snapshot = breaker.snapshot(URL_A);
      expect(snapshot.failureThreshold).toBe(3);
      expect(snapshot.recoveryAfterMs).toBe(24 * HOUR);
    });
  });

  describe("shared instance", () => {
    it("returns the same breaker on every call", () => {
      // Two independent breakers would each count their own failures and
      // neither would reach its threshold, so a dead endpoint could fail
      // forever without tripping anything.
      expect(getWebhookCircuitBreaker()).toBe(getWebhookCircuitBreaker());
    });

    it("can be replaced and cleared for tests", () => {
      const replacement = new WebhookCircuitBreaker({ failureThreshold: 1 });
      setWebhookCircuitBreaker(replacement);
      expect(getWebhookCircuitBreaker()).toBe(replacement);

      setWebhookCircuitBreaker(null);
      expect(getWebhookCircuitBreaker()).not.toBe(replacement);
    });
  });
});
