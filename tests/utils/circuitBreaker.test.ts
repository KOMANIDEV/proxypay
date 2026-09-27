jest.mock("../../src/utils/metrics", () => ({
  providerCircuitBreakerState: {
    set: jest.fn(),
  },
  providerCircuitBreakerTransitionsTotal: {
    inc: jest.fn(),
  },
}));

jest.mock("../../src/services/mobilemoney/providers/healthCheck", () => ({
  checkMobileMoneyHealth: jest.fn(),
}));

import {
  classifyCircuitBreakerFailure,
  executeWithCircuitBreaker,
  getCircuitBreakerCount,
  getCircuitBreakerState,
  resetCircuitBreaker,
  resetCircuitBreakers,
  checkAndResetCircuitBreaker,
} from "../../src/utils/circuitBreaker";
import {
  providerCircuitBreakerState,
  providerCircuitBreakerTransitionsTotal,
} from "../../src/utils/metrics";
import { checkMobileMoneyHealth } from "../../src/services/mobilemoney/providers/healthCheck";

describe("executeWithCircuitBreaker", () => {
  beforeEach(() => {
    process.env.PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD = "1";
    process.env.PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE = "1";
    process.env.PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = "25";
    resetCircuitBreakers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetCircuitBreakers();
  });

  it("emits metrics when the circuit transitions from open to half-open to closed", async () => {
    await expect(
      executeWithCircuitBreaker({
        provider: "mtn",
        operation: "requestPayment",
        execute: async () => ({
          success: false,
          error: new Error("provider-down"),
        }),
      }),
    ).rejects.toThrow("provider-down");

    await new Promise((resolve) => setTimeout(resolve, 40));

    const result = await executeWithCircuitBreaker({
      provider: "mtn",
      operation: "requestPayment",
      execute: async () => ({
        success: true,
        data: { reference: "recovered" },
      }),
    });

    expect(result).toEqual({
      success: true,
      data: { reference: "recovered" },
    });
    expect(providerCircuitBreakerTransitionsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      operation: "requestPayment",
      state: "open",
    });
    expect(providerCircuitBreakerTransitionsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      operation: "requestPayment",
      state: "half_open",
    });
    expect(providerCircuitBreakerTransitionsTotal.inc).toHaveBeenCalledWith({
      provider: "mtn",
      operation: "requestPayment",
      state: "closed",
    });
    expect(providerCircuitBreakerState.set).toHaveBeenCalledWith(
      { provider: "mtn", operation: "requestPayment" },
      1,
    );
    expect(providerCircuitBreakerState.set).toHaveBeenCalledWith(
      { provider: "mtn", operation: "requestPayment" },
      0.5,
    );
    expect(providerCircuitBreakerState.set).toHaveBeenCalledWith(
      { provider: "mtn", operation: "requestPayment" },
      0,
    );
  });

  it("reuses the same breaker per provider and operation until reset", async () => {
    await executeWithCircuitBreaker({
      provider: "mtn",
      operation: "requestPayment",
      execute: async () => ({
        success: true,
        data: { reference: "one" },
      }),
    });
    await executeWithCircuitBreaker({
      provider: "mtn",
      operation: "requestPayment",
      execute: async () => ({
        success: true,
        data: { reference: "two" },
      }),
    });

    expect(getCircuitBreakerCount()).toBe(1);

    resetCircuitBreakers();

    expect(getCircuitBreakerCount()).toBe(0);
  });

  it("does not count business failures against the circuit", async () => {
    const result = await executeWithCircuitBreaker({
      provider: "gateway",
      operation: "charge",
      execute: async () => ({
        success: false,
        failureType: "business",
        error: new Error("insufficient funds"),
      }),
    });

    expect(result.success).toBe(false);
    expect(getCircuitBreakerState("gateway", "charge")).toBe("closed");
  });

  it("classifies failures and supports integration-specific health checks", async () => {
    expect(classifyCircuitBreakerFailure({ statusCode: 503 })).toBe("server");
    expect(classifyCircuitBreakerFailure(new Error("ETIMEDOUT"))).toBe("timeout");

    await expect(
      executeWithCircuitBreaker({
        provider: "compliance",
        operation: "screen",
        execute: async () => ({ success: false, error: new Error("service-down") }),
      }),
    ).rejects.toThrow("service-down");

    const healthCheck = jest.fn().mockResolvedValue(true);
    expect(await checkAndResetCircuitBreaker("compliance", "screen", healthCheck)).toBe(true);
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(resetCircuitBreaker("compliance", "screen")).toBe(true);
    expect(getCircuitBreakerState("compliance", "screen")).toBe("not_found");
  });

  describe("checkAndResetCircuitBreaker", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("resets open breaker when provider is healthy", async () => {
      // First open the breaker
      await expect(
        executeWithCircuitBreaker({
          provider: "mtn",
          operation: "requestPayment",
          execute: async () => ({
            success: false,
            error: new Error("provider-down"),
          }),
        }),
      ).rejects.toThrow("provider-down");

      // Mock health check as up
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
        providers: {
          mtn: { status: "up", responseTime: 100 },
        },
      });

      const reset = await checkAndResetCircuitBreaker("mtn", "requestPayment");
      expect(reset).toBe(true);
      expect(checkMobileMoneyHealth).toHaveBeenCalled();
    });

    it("does not reset if breaker is not open", async () => {
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
        providers: {
          mtn: { status: "up", responseTime: 100 },
        },
      });

      const reset = await checkAndResetCircuitBreaker("mtn", "requestPayment");
      expect(reset).toBe(false);
      expect(checkMobileMoneyHealth).not.toHaveBeenCalled();
    });

    it("does not reset if provider is down", async () => {
      // First open the breaker
      await expect(
        executeWithCircuitBreaker({
          provider: "mtn",
          operation: "requestPayment",
          execute: async () => ({
            success: false,
            error: new Error("provider-down"),
          }),
        }),
      ).rejects.toThrow("provider-down");

      // Mock health check as down
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValue({
        providers: {
          mtn: { status: "down", responseTime: null },
        },
      });

      const reset = await checkAndResetCircuitBreaker("mtn", "requestPayment");
      expect(reset).toBe(false);
      expect(checkMobileMoneyHealth).toHaveBeenCalled();
    });
  });
});
