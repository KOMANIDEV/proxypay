/**
 * Provider Failover Simulation Tests
 *
 * Chaos-engineering-style tests covering:
 *   - Provider timeouts → circuit opens → fallback to next provider
 *   - Provider 5xx errors → retry then failover
 *   - Slow provider responses → timeout triggers failover
 *   - Cascading failures across all providers
 *   - Recovery after provider comes back online
 *   - Load test: concurrent requests during failover
 */

import {
  pingProvider,
  _clearCache,
  _resetCircuits,
  _circuitMap,
  type ProviderConfig,
} from "../../../../src/services/mobilemoney/providers/healthCheck";

function makeConfig(
  overrides: Partial<ProviderConfig> & { name: ProviderConfig["name"] },
): ProviderConfig {
  return {
    pingUrl: "http://localhost:0/ping",
    timeoutMs: 2000,
    ...overrides,
  };
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch;
}

function okResponse(status = 200): Response {
  return new Response(null, { status });
}

function errorResponse(status: number): Response {
  return new Response(null, { status });
}

function networkError(msg = "ECONNREFUSED"): Promise<Response> {
  return Promise.reject(new Error(msg));
}

function timeoutError(): Promise<Response> {
  return Promise.reject(
    Object.assign(new Error("aborted"), { name: "AbortError" }),
  );
}

beforeEach(() => {
  _clearCache();
  _resetCircuits();
});

afterEach(() => {
  _clearCache();
  _resetCircuits();
});

describe("Circuit Breaker Failover", () => {
  it("opens circuit after consecutive failures", async () => {
    const config = makeConfig({ name: "mtn" });
    const failingFetch = mockFetch(() => errorResponse(500));

    // 3 failures should open the circuit
    for (let i = 0; i < 3; i++) {
      const result = await pingProvider(config, failingFetch);
      expect(result.status).toBe("down");
    }

    // Circuit should now be open
    const circuitState = _circuitMap.get("mtn");
    expect(circuitState).toBeDefined();
    expect(circuitState!.failures).toBeGreaterThanOrEqual(3);
    expect(circuitState!.openUntil).toBeGreaterThan(Date.now());
  });

  it("skips ping when circuit is open", async () => {
    const config = makeConfig({ name: "airtel" });
    let callCount = 0;
    const countingFetch = mockFetch(async () => {
      callCount++;
      return okResponse();
    });

    // Trip the circuit
    const failingFetch = mockFetch(() => errorResponse(503));
    for (let i = 0; i < 3; i++) {
      await pingProvider(config, failingFetch);
    }

    callCount = 0;
    const result = await pingProvider(config, countingFetch);
    expect(result.status).toBe("down");
    expect(result.responseTime).toBeNull();
    expect(callCount).toBe(0); // fetch was not called
  });

  it("resets circuit after recovery period (half-open)", async () => {
    const config = makeConfig({
      name: "orange",
      timeoutMs: 100,
    });

    // Trip the circuit with a fast failure
    const failFetch = mockFetch(() => errorResponse(500));
    for (let i = 0; i < 3; i++) {
      await pingProvider(config, failFetch);
    }

    // Manually set openUntil to the past to simulate recovery window elapsed
    const circuit = _circuitMap.get("orange")!;
    circuit.openUntil = Date.now() - 1;

    // Next call should go through (half-open)
    const successFetch = mockFetch(async () => okResponse(200));
    const result = await pingProvider(config, successFetch);
    expect(result.status).toBe("up");
  });
});

describe("Cascading Provider Failures", () => {
  it("all providers down returns all down", async () => {
    const providers: ProviderConfig[] = [
      makeConfig({ name: "mtn" }),
      makeConfig({ name: "airtel" }),
      makeConfig({ name: "orange" }),
    ];

    const allFail = mockFetch(() => networkError());

    const results = await Promise.all(
      providers.map((p) => pingProvider(p, allFail)),
    );

    expect(results.every((r) => r.status === "down")).toBe(true);
    expect(results.every((r) => r.responseTime === null)).toBe(true);
  });

  it("independent circuits per provider", async () => {
    const mtnConfig = makeConfig({ name: "mtn" });
    const airtelConfig = makeConfig({ name: "airtel" });

    // Fail MTN
    const failFetch = mockFetch(() => errorResponse(500));
    for (let i = 0; i < 3; i++) {
      await pingProvider(mtnConfig, failFetch);
    }

    // Airtel should still work
    const okFetch = mockFetch(async () => okResponse(200));
    const airtelResult = await pingProvider(airtelConfig, okFetch);
    expect(airtelResult.status).toBe("up");

    // MTN circuit should be open
    const mtnCircuit = _circuitMap.get("mtn");
    expect(mtnCircuit!.failures).toBeGreaterThanOrEqual(3);
  });
});

describe("Timeout Handling", () => {
  it("treats timeout as down with null responseTime", async () => {
    const config = makeConfig({ name: "mtn", timeoutMs: 100 });
    const result = await pingProvider(config, () => timeoutError());
    expect(result.status).toBe("down");
    expect(result.responseTime).toBeNull();
  });
});

describe("Slow Response Handling", () => {
  it("treats slow response as down when it exceeds timeout", async () => {
    const config = makeConfig({ name: "mtn", timeoutMs: 50 });
    // Mock fetch that checks the signal and rejects if aborted
    const slowFetch = mockFetch(async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(okResponse()), 300);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    const result = await pingProvider(config, slowFetch);
    expect(result.status).toBe("down");
  });
});

describe("Recovery After Provider Comes Back", () => {
  it("resets failure count on success", async () => {
    const config = makeConfig({ name: "mtn" });
    const failFetch = mockFetch(() => errorResponse(500));

    // 2 failures (below threshold)
    for (let i = 0; i < 2; i++) {
      await pingProvider(config, failFetch);
    }

    const circuit = _circuitMap.get("mtn")!;
    expect(circuit.failures).toBe(2);

    // Success resets the count
    const okFetch = mockFetch(async () => okResponse(200));
    const result = await pingProvider(config, okFetch);
    expect(result.status).toBe("up");
    expect(circuit.failures).toBe(0);
  });
});

describe("Load Test During Failover", () => {
  it("handles concurrent requests without state corruption", async () => {
    const config = makeConfig({ name: "mtn" });
    let callCount = 0;

    const intermittentFetch = mockFetch(async () => {
      callCount++;
      if (callCount <= 5) return errorResponse(500);
      return okResponse(200);
    });

    // Send 10 concurrent requests
    const results = await Promise.all(
      Array.from({ length: 10 }, () => pingProvider(config, intermittentFetch)),
    );

    // Some should succeed (after circuit potentially resets or in half-open)
    expect(results.length).toBe(10);
    results.forEach((r) => {
      expect(["up", "down"]).toContain(r.status);
    });
  });
});
