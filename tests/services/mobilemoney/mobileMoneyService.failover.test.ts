import { 
  resetCircuitBreakers, 
  resetCircuitBreakerForProvider, 
  checkAndResetCircuitBreaker,
  getCircuitBreakerCount 
} from "../../../src/utils/circuitBreaker";

describe("Circuit Breaker Utility Functions", () => {
  beforeEach(() => {
    resetCircuitBreakers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetCircuitBreakers();
  });

  it("exports circuit breaker management functions", () => {
    expect(typeof resetCircuitBreakers).toBe("function");
    expect(typeof resetCircuitBreakerForProvider).toBe("function");
    expect(typeof checkAndResetCircuitBreaker).toBe("function");
    expect(typeof getCircuitBreakerCount).toBe("function");
  });

  it("can reset all circuit breakers", () => {
    expect(() => resetCircuitBreakers()).not.toThrow();
  });

  it("can reset circuit breaker for specific provider", () => {
    expect(() => resetCircuitBreakerForProvider("mtn")).not.toThrow();
    expect(() => resetCircuitBreakerForProvider("airtel")).not.toThrow();
  });

  it("provides circuit breaker count", () => {
    expect(typeof getCircuitBreakerCount).toBe("function");
    expect(typeof getCircuitBreakerCount()).toBe("number");
  });

  it("can check and reset circuit breaker based on health", async () => {
    const result = await checkAndResetCircuitBreaker("mtn", "requestPayment");
    expect(typeof result).toBe("boolean");
  });
});

describe("Circuit Breaker State Management", () => {
  beforeEach(() => {
    resetCircuitBreakers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetCircuitBreakers();
  });

  it("can reset all circuit breakers", () => {
    expect(() => resetCircuitBreakers()).not.toThrow();
  });

  it("can reset circuit breaker for specific provider", () => {
    expect(() => resetCircuitBreakerForProvider("mtn")).not.toThrow();
    expect(() => resetCircuitBreakerForProvider("airtel")).not.toThrow();
  });

  it("provides circuit breaker count", () => {
    expect(typeof getCircuitBreakerCount).toBe("function");
    expect(typeof getCircuitBreakerCount()).toBe("number");
  });

  it("can check and reset circuit breaker based on health", async () => {
    const result = await checkAndResetCircuitBreaker("mtn", "requestPayment");
    expect(typeof result).toBe("boolean");
  });
});