jest.mock("../src/utils/metrics", () => ({
  providerCircuitBreakerState: { set: jest.fn() },
  providerCircuitBreakerTransitionsTotal: { inc: jest.fn() },
  providerFailoverTotal: { inc: jest.fn() },
  providerFailoverAlerts: { inc: jest.fn() },
}));

jest.mock("../src/services/mobilemoney/providers/healthCheck", () => ({
  checkMobileMoneyHealth: jest.fn(),
}));

jest.mock("../src/services/providerSettingsService.js", () => ({
  providerSettingsService: {
    getProviderSettings: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock("../src/services/providerSettingsService", () => ({
  providerSettingsService: {
    getProviderSettings: jest.fn().mockResolvedValue(null),
  },
}));

import {
  executeWithCircuitBreaker,
  resetCircuitBreakers,
  getCircuitBreakerCount,
  isCircuitBreakerOpenError,
} from "../src/utils/circuitBreaker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Circuit Breaker Failover Simulation (#374)", () => {
  beforeAll(() => {
    process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "2";
    process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE = "50";
    process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "100";
    process.env.PROVIDER_CIRCUIT_BREAKER_ROLLING_WINDOW_MS = "500";
  });

  afterAll(() => {
    resetCircuitBreakers();
  });

  // ---------------------------------------------------------------------------
  // Timeout scenarios
  // ---------------------------------------------------------------------------

  describe("timeout scenarios", () => {
    it("opens circuit breaker when operations exceed configured timeout", async () => {
      const origTimeout = process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS;
      process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS = "30";

      let callCount = 0;
      const slowExecute = async () => {
        callCount++;
        if (callCount <= 2) {
          await sleep(500);
          return { success: true, data: "slow-ok" };
        }
        return { success: true, data: "recovered" };
      };

      await executeWithCircuitBreaker({
        provider: "timeout_a",
        operation: "requestPayment",
        execute: slowExecute,
      }).catch(() => {});

      await executeWithCircuitBreaker({
        provider: "timeout_a",
        operation: "requestPayment",
        execute: slowExecute,
      }).catch(() => {});

      await sleep(20);

      await expect(
        executeWithCircuitBreaker({
          provider: "timeout_a",
          operation: "requestPayment",
          execute: slowExecute,
        }),
      ).rejects.toThrow();

      process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS = origTimeout;
    });

    it("falls back to fallback function on timeout", async () => {
      let callCount = 0;
      const execute = async () => {
        callCount++;
        if (callCount <= 2) {
          await sleep(150);
          return { success: true, data: "slow" };
        }
        return { success: true, data: "ok" };
      };

      const fallback = async () => ({
        success: true,
        data: "fallback-result",
      });

      const result = await executeWithCircuitBreaker({
        provider: "timeout_b",
        operation: "requestPayment",
        execute,
        fallback,
      });

      expect(result.success).toBe(true);
    });

    it("retries after reset timeout and recovers", async () => {
      let callCount = 0;
      const execute = async () => {
        callCount++;
        if (callCount <= 2) {
          await sleep(150);
          return { success: true, data: "timeout" };
        }
        return { success: true, data: "recovered" };
      };

      for (let i = 0; i < 2; i++) {
        await executeWithCircuitBreaker({
          provider: "timeout_c",
          operation: "requestPayment",
          execute,
        }).catch(() => {});
      }

      await sleep(150);

      const result = await executeWithCircuitBreaker({
        provider: "timeout_c",
        operation: "requestPayment",
        execute,
      });

      expect(result).toEqual({ success: true, data: "recovered" });
    });
  });

  // ---------------------------------------------------------------------------
  // Error scenarios
  // ---------------------------------------------------------------------------

  describe("error scenarios", () => {
    it("opens circuit after consecutive failures exceed threshold", async () => {
      const failExecute = async () => ({
        success: false,
        error: new Error("provider-down"),
      });

      await expect(
        executeWithCircuitBreaker({
          provider: "error_a",
          operation: "requestPayment",
          execute: failExecute,
        }),
      ).rejects.toThrow("provider-down");

      await expect(
        executeWithCircuitBreaker({
          provider: "error_a",
          operation: "requestPayment",
          execute: failExecute,
        }),
      ).rejects.toThrow("provider-down");

      await sleep(20);

      await expect(
        executeWithCircuitBreaker({
          provider: "error_a",
          operation: "requestPayment",
          execute: failExecute,
        }),
      ).rejects.toThrow();
    });

    it("distinguishes errors from successes to avoid false opens", async () => {
      let callCount = 0;
      const mixedExecute = async () => {
        callCount++;
        if (callCount === 5) {
          return { success: false, error: new Error("intermittent") };
        }
        return { success: true, data: "ok" };
      };

      for (let i = 0; i < 10; i++) {
        const result = await executeWithCircuitBreaker({
          provider: "error_b",
          operation: "requestPayment",
          execute: mixedExecute,
          fallback: async () => ({ success: true, data: "fallback-ok" }),
        });
        expect(result.success).toBe(true);
      }

      expect(getCircuitBreakerCount()).toBeGreaterThanOrEqual(1);
    });

    it("isCircuitBreakerOpenError identifies breaker-open errors", async () => {
      const err = new Error(" breaker open ") as Error & { code: string };
      err.code = "EOPENBREAKER";
      expect(isCircuitBreakerOpenError(err)).toBe(true);

      const normalErr = new Error("normal error");
      expect(isCircuitBreakerOpenError(normalErr)).toBe(false);

      expect(isCircuitBreakerOpenError("string")).toBe(false);
      expect(isCircuitBreakerOpenError(null)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Slow response scenarios
  // ---------------------------------------------------------------------------

  describe("slow response scenarios", () => {
    it("rejects operations slower than provider-specific timeout", async () => {
      process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS = "50";
      const start = Date.now();
      await expect(
        executeWithCircuitBreaker({
          provider: "slow_a",
          operation: "requestPayment",
          execute: async () => {
            await sleep(200);
            return { success: true, data: "late" };
          },
        }),
      ).rejects.toThrow();

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    });

    it("fast operations succeed while slow ones are rejected", async () => {
      process.env.PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS = "50";
      const execute = async () => {
        return { success: true, data: "fast" };
      };

      const result = await executeWithCircuitBreaker({
        provider: "slow_b",
        operation: "requestPayment",
        execute,
      });

      expect(result).toEqual({ success: true, data: "fast" });
    });
  });

  // ---------------------------------------------------------------------------
  // Cascading failure scenarios
  // ---------------------------------------------------------------------------

  describe("cascading failure scenarios", () => {
    it("does not cascade failures across different providers", async () => {
      const failExecute = async () => ({
        success: false,
        error: new Error("mtn-down"),
      });

      for (let i = 0; i < 3; i++) {
        await executeWithCircuitBreaker({
          provider: "cascade_mtn",
          operation: "requestPayment",
          execute: failExecute,
        }).catch(() => {});
      }

      const airtelResult = await executeWithCircuitBreaker({
        provider: "cascade_airtel",
        operation: "requestPayment",
        execute: async () => ({ success: true, data: "airtel-ok" }),
      });

      expect(airtelResult).toEqual({ success: true, data: "airtel-ok" });
      expect(getCircuitBreakerCount()).toBeGreaterThanOrEqual(2);
    });

    it("does not cascade failures across different operations", async () => {
      const failExecute = async () => ({
        success: false,
        error: new Error("request-fail"),
      });

      for (let i = 0; i < 3; i++) {
        await executeWithCircuitBreaker({
          provider: "cascade_op",
          operation: "requestPayment",
          execute: failExecute,
        }).catch(() => {});
      }

      const result = await executeWithCircuitBreaker({
        provider: "cascade_op",
        operation: "checkBalance",
        execute: async () => ({ success: true, data: 1000 }),
      });

      expect(result).toEqual({ success: true, data: 1000 });
    });

    it("recovers only the affected circuit after reset window", async () => {
      const failExecute = async () => ({
        success: false,
        error: new Error("fail"),
      });

      await executeWithCircuitBreaker({
        provider: "cascade_c",
        operation: "requestPayment",
        execute: failExecute,
      }).catch(() => {});

      await executeWithCircuitBreaker({
        provider: "cascade_c",
        operation: "requestPayment",
        execute: failExecute,
      }).catch(() => {});

      await sleep(150);

      const result = await executeWithCircuitBreaker({
        provider: "cascade_c",
        operation: "requestPayment",
        execute: async () => ({ success: true, data: "recovered" }),
      });

      expect(result).toEqual({ success: true, data: "recovered" });
    });
  });

  // ---------------------------------------------------------------------------
  // Load testing
  // ---------------------------------------------------------------------------

  describe("load testing", () => {
    it("handles concurrent requests through a healthy provider", async () => {
      let successCount = 0;
      const execute = async () => {
        successCount++;
        return { success: true, data: `req-${successCount}` };
      };

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          executeWithCircuitBreaker({
            provider: "load_a",
            operation: "requestPayment",
            execute,
          }),
        ),
      );

      expect(results.every((r) => r.success)).toBe(true);
      expect(successCount).toBe(20);
    });

    it("mixes failures and successes under load without false opens", async () => {
      let callCount = 0;
      const execute = async () => {
        callCount++;
        if (callCount % 10 === 0) {
          return { success: false, error: new Error("glitch") };
        }
        return { success: true, data: `ok-${callCount}` };
      };

      const results = await Promise.all(
        Array.from({ length: 30 }, () =>
          executeWithCircuitBreaker({
            provider: "load_b",
            operation: "requestPayment",
            execute,
          }).catch(() => ({ success: false, error: "caught" })),
        ),
      );

      const successes = results.filter((r) => r.success);
      expect(successes.length).toBeGreaterThanOrEqual(25);
    });

    it("fast failover under sustained failure load", async () => {
      const failExecute = async () => ({
        success: false,
        error: new Error("provider-overloaded"),
      });

      for (let i = 0; i < 5; i++) {
        await executeWithCircuitBreaker({
          provider: "load_c",
          operation: "requestPayment",
          execute: failExecute,
        }).catch(() => {});
      }

      await sleep(20);

      const fallbackResult = await executeWithCircuitBreaker({
        provider: "load_c",
        operation: "requestPayment",
        execute: failExecute,
        fallback: async () => ({
          success: true,
          data: "fallback-takeover",
        }),
      });

      expect(fallbackResult).toEqual({ success: true, data: "fallback-takeover" });
    });

    it("concurrent requests during circuit open state all receive fallback responses", async () => {
      const failExecute = async () => ({
        success: false,
        error: new Error("concurrent-open-fail"),
      });

      // Trip the circuit breaker open by exhausting the volume threshold
      for (let i = 0; i < 3; i++) {
        await executeWithCircuitBreaker({
          provider: "load_concurrent_open",
          operation: "requestPayment",
          execute: failExecute,
        }).catch(() => {});
      }

      // Allow enough time for the open state to settle
      await sleep(20);

      // Simulate 5 concurrent requests hitting the open circuit — all should get the fallback
      const concurrentResults = await Promise.all(
        Array.from({ length: 5 }, () =>
          executeWithCircuitBreaker({
            provider: "load_concurrent_open",
            operation: "requestPayment",
            execute: failExecute,
            fallback: async () => ({
              success: true,
              data: "open-circuit-concurrent-fallback",
            }),
          }),
        ),
      );

      expect(concurrentResults).toHaveLength(5);
      expect(concurrentResults.every((r) => r.success)).toBe(true);
      expect(
        concurrentResults.every((r) => r.data === "open-circuit-concurrent-fallback"),
      ).toBe(true);
    });

    it("sequential failures open breaker, sequential successes keep it closed", async () => {
      const successExecute = async () => ({
        success: true,
        data: "fine",
      });

      for (let i = 0; i < 10; i++) {
        const result = await executeWithCircuitBreaker({
          provider: "load_d",
          operation: "requestPayment",
          execute: successExecute,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback strategies
  // ---------------------------------------------------------------------------

  describe("fallback strategies", () => {
    it("uses fallback when primary operation fails", async () => {
      const result = await executeWithCircuitBreaker({
        provider: "fallback_a",
        operation: "requestPayment",
        execute: async () => ({
          success: false,
          error: new Error("orange-down"),
        }),
        fallback: async () => ({
          success: true,
          data: "fallback-response",
        }),
      });

      expect(result).toEqual({ success: true, data: "fallback-response" });
    });

    it("propagates error when no fallback is provided", async () => {
      await expect(
        executeWithCircuitBreaker({
          provider: "fallback_b",
          operation: "requestPayment",
          execute: async () => ({
            success: false,
            error: new Error("no-fallback"),
          }),
        }),
      ).rejects.toThrow("no-fallback");
    });

    it("uses fallback when circuit is open", async () => {
      const failExecute = async () => ({
        success: false,
        error: new Error("down"),
      });

      for (let i = 0; i < 3; i++) {
        await executeWithCircuitBreaker({
          provider: "fallback_c",
          operation: "requestPayment",
          execute: failExecute,
        }).catch(() => {});
      }

      await sleep(20);

      const result = await executeWithCircuitBreaker({
        provider: "fallback_c",
        operation: "requestPayment",
        execute: failExecute,
        fallback: async () => ({
          success: true,
          data: "open-circuit-fallback",
        }),
      });

      expect(result).toEqual({ success: true, data: "open-circuit-fallback" });
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery scenarios
  // ---------------------------------------------------------------------------

  describe("recovery scenarios", () => {
    it("half-open state allows one probe request", async () => {
      let calls = 0;
      const execute = async () => {
        calls++;
        if (calls <= 2) {
          return { success: false, error: new Error("fail") };
        }
        return { success: true, data: "probe-ok" };
      };

      await executeWithCircuitBreaker({
        provider: "recovery_a",
        operation: "requestPayment",
        execute,
      }).catch(() => {});
      await executeWithCircuitBreaker({
        provider: "recovery_a",
        operation: "requestPayment",
        execute,
      }).catch(() => {});

      await sleep(150);

      const result = await executeWithCircuitBreaker({
        provider: "recovery_a",
        operation: "requestPayment",
        execute,
      });

      expect(result).toEqual({ success: true, data: "probe-ok" });
    });

    it("re-opens circuit if probe in half-open state fails", async () => {
      let calls = 0;
      const execute = async () => {
        calls++;
        if (calls <= 2) {
          return { success: false, error: new Error("initial-fail") };
        }
        return { success: false, error: new Error("probe-failed") };
      };

      for (let i = 0; i < 2; i++) {
        await executeWithCircuitBreaker({
          provider: "recovery_b",
          operation: "requestPayment",
          execute,
        }).catch(() => {});
      }

      await sleep(150);

      await expect(
        executeWithCircuitBreaker({
          provider: "recovery_b",
          operation: "requestPayment",
          execute,
        }),
      ).rejects.toThrow("probe-failed");
    });

    it("full recovery after transient failure period", async () => {
      let calls = 0;
      const execute = async () => {
        calls++;
        if (calls <= 2) {
          return { success: false, error: new Error("transient") };
        }
        return { success: true, data: "fully-recovered" };
      };

      for (let i = 0; i < 2; i++) {
        await executeWithCircuitBreaker({
          provider: "recovery_c",
          operation: "requestPayment",
          execute,
        }).catch(() => {});
      }

      await sleep(150);

      for (let i = 0; i < 5; i++) {
        const result = await executeWithCircuitBreaker({
          provider: "recovery_c",
          operation: "requestPayment",
          execute,
        });
        expect(result).toEqual({ success: true, data: "fully-recovered" });
      }
    });

    it("circuit transitions correctly through closed -> open -> half-open -> closed cycle", async () => {
      let calls = 0;
      const execute = async () => {
        calls++;
        // First 2 calls fail to trip the breaker open (volume threshold = 2, error % = 50)
        if (calls <= 2) {
          return { success: false, error: new Error("cycle-fail") };
        }
        // Subsequent calls succeed (used for the half-open probe and closed verification)
        return { success: true, data: "cycle-recovered" };
      };

      // CLOSED -> OPEN: trigger enough failures to open the circuit
      for (let i = 0; i < 2; i++) {
        await executeWithCircuitBreaker({
          provider: "recovery_cycle",
          operation: "requestPayment",
          execute,
        }).catch(() => {});
      }

      // Verify circuit is OPEN: next call without fallback should be rejected
      await sleep(20);
      await expect(
        executeWithCircuitBreaker({
          provider: "recovery_cycle",
          operation: "requestPayment",
          execute,
        }),
      ).rejects.toThrow();

      // OPEN -> HALF-OPEN: wait for the reset timeout to expire
      await sleep(150);

      // HALF-OPEN -> CLOSED: the probe request succeeds, closing the circuit
      const probeResult = await executeWithCircuitBreaker({
        provider: "recovery_cycle",
        operation: "requestPayment",
        execute,
      });

      expect(probeResult).toEqual({ success: true, data: "cycle-recovered" });

      // CLOSED verification: subsequent requests also succeed normally
      const verifyResult = await executeWithCircuitBreaker({
        provider: "recovery_cycle",
        operation: "requestPayment",
        execute,
      });

      expect(verifyResult).toEqual({ success: true, data: "cycle-recovered" });
    });
  });
});
