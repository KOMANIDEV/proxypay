jest.mock("../../src/queue/dlq", () => ({
  capturePersistentFailure: jest.fn(),
}));

import { capturePersistentFailure } from "../../src/queue/dlq";
import { 
  deliverWithRetry, 
  calculateBackoffDelay, 
  isRetryableError 
} from "../../src/services/merchantWebhookService";

describe("MerchantWebhookService - Retry Backoff", () => {
  const createMockFetch = (responses: Array<{ ok: boolean; status: number; body?: string }>) => {
    let callIndex = 0;
    return jest.fn(async () => {
      const response = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return {
        ok: response.ok,
        status: response.status,
        text: async () => response.body || "",
      };
    });
  };

  it("should retry on 5xx errors with exponential backoff", async () => {
    const mockFetch = createMockFetch([
      { ok: false, status: 503 },
      { ok: false, status: 500 },
      { ok: true, status: 200 },
    ]);

    const result = await deliverWithRetry(
      "https://example.com/webhook",
      "test-secret",
      { test: "data" },
      mockFetch as unknown as typeof fetch,
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10000, jitterFactor: 0, backoffMultiplier: 2 },
    );

    expect(result.status).toBe("delivered");
    expect(result.attempts).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("should not retry on 4xx client errors (except 429)", async () => {
    const mockFetch = createMockFetch([
      { ok: false, status: 400 },
    ]);

    const result = await deliverWithRetry(
      "https://example.com/webhook",
      "test-secret",
      { test: "data" },
      mockFetch as unknown as typeof fetch,
      { maxAttempts: 3, baseDelayMs: 10, jitterFactor: 0 },
    );

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should retry on 429 rate limit errors", async () => {
    const mockFetch = createMockFetch([
      { ok: false, status: 429 },
      { ok: true, status: 200 },
    ]);

    const result = await deliverWithRetry(
      "https://example.com/webhook",
      "test-secret",
      { test: "data" },
      mockFetch as unknown as typeof fetch,
      { maxAttempts: 3, baseDelayMs: 10, jitterFactor: 0 },
    );

    expect(result.status).toBe("delivered");
    expect(result.attempts).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should retry on network errors", async () => {
    let callCount = 0;
    const mockFetch = jest.fn(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("Network error");
      }
      return { ok: true, status: 200, text: async () => "" };
    });

    const result = await deliverWithRetry(
      "https://example.com/webhook",
      "test-secret",
      { test: "data" },
      mockFetch as unknown as typeof fetch,
      { maxAttempts: 3, baseDelayMs: 10, jitterFactor: 0 },
    );

    expect(result.status).toBe("delivered");
    expect(result.attempts).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("should respect max delay cap", async () => {
    const mockFetch = createMockFetch([
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
    ]);

    const result = await deliverWithRetry(
      "https://example.com/webhook",
      "test-secret",
      { test: "data" },
      mockFetch as unknown as typeof fetch,
      { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 500, jitterFactor: 0 },
    );

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(4);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("should enqueue exhausted webhook failures to the dead-letter queue", async () => {
    const mockFetch = createMockFetch([
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
    ]);

    await deliverWithRetry(
      "https://example.com/webhook",
      "test-secret",
      { test: "data" },
      mockFetch as unknown as typeof fetch,
      { maxAttempts: 3, baseDelayMs: 10, jitterFactor: 0 },
    );

    expect(capturePersistentFailure).toHaveBeenCalledWith(expect.objectContaining({
      queueName: "merchant-webhooks",
      jobName: "deliver-webhook",
      failureReason: expect.stringContaining("HTTP 503"),
      attemptsMade: 3,
      jobData: expect.objectContaining({
        url: "https://example.com/webhook",
        payload: { test: "data" },
      }),
    }));
  });

  it("should apply jitter when enabled", () => {
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(calculateBackoffDelay(1000, 0, 10000, 0.5, 2));
    }
    
    // With 50% jitter, delay should be between 1000 and 1500
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1500);
  });

  it("should track total duration across retries", async () => {
    const mockFetch = createMockFetch([
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);

    const result = await deliverWithRetry(
      "https://example.com/webhook",
      "test-secret",
      { test: "data" },
      mockFetch as unknown as typeof fetch,
      { maxAttempts: 3, baseDelayMs: 10, jitterFactor: 0 },
    );

    expect(result.attempts).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  describe("isRetryableError", () => {
    it("should return true for 429", () => {
      expect(isRetryableError(new Error("test"), 429)).toBe(true);
    });

    it("should return true for 500", () => {
      expect(isRetryableError(new Error("test"), 500)).toBe(true);
    });

    it("should return true for 502", () => {
      expect(isRetryableError(new Error("test"), 502)).toBe(true);
    });

    it("should return true for 503", () => {
      expect(isRetryableError(new Error("test"), 503)).toBe(true);
    });

    it("should return true for 504", () => {
      expect(isRetryableError(new Error("test"), 504)).toBe(true);
    });

    it("should return false for 400", () => {
      expect(isRetryableError(new Error("test"), 400)).toBe(false);
    });

    it("should return false for 401", () => {
      expect(isRetryableError(new Error("test"), 401)).toBe(false);
    });

    it("should return false for 404", () => {
      expect(isRetryableError(new Error("test"), 404)).toBe(false);
    });

    it("should return true for network errors (no status code)", () => {
      expect(isRetryableError(new Error("Network error"))).toBe(true);
    });

    it("should return true for timeout errors", () => {
      const timeoutError = new Error("Timeout");
      timeoutError.name = "AbortError";
      expect(isRetryableError(timeoutError)).toBe(true);
    });
  });

  describe("calculateBackoffDelay", () => {
    it("should calculate exponential backoff correctly", () => {
      expect(calculateBackoffDelay(500, 0, 30000, 0, 2)).toBe(500);   // 500 * 2^0
      expect(calculateBackoffDelay(500, 1, 30000, 0, 2)).toBe(1000);  // 500 * 2^1
      expect(calculateBackoffDelay(500, 2, 30000, 0, 2)).toBe(2000);  // 500 * 2^2
      expect(calculateBackoffDelay(500, 3, 30000, 0, 2)).toBe(4000);  // 500 * 2^3
      expect(calculateBackoffDelay(500, 4, 30000, 0, 2)).toBe(8000);  // 500 * 2^4
    });

    it("should respect max delay cap", () => {
      expect(calculateBackoffDelay(1000, 10, 5000, 0, 2)).toBe(5000);
    });

    it("should use backoff multiplier", () => {
      expect(calculateBackoffDelay(100, 0, 10000, 0, 3)).toBe(100);   // 100 * 3^0
      expect(calculateBackoffDelay(100, 1, 10000, 0, 3)).toBe(300);   // 100 * 3^1
      expect(calculateBackoffDelay(100, 2, 10000, 0, 3)).toBe(900);   // 100 * 3^2
    });

    it("should add jitter when jitterFactor > 0", () => {
      const delays = Array.from({ length: 100 }, () => calculateBackoffDelay(1000, 0, 10000, 0.2, 2));
      const minDelay = Math.min(...delays);
      const maxDelay = Math.max(...delays);
      
      // With 20% jitter, delay should be between 1000 and 1200
      expect(minDelay).toBeGreaterThanOrEqual(1000);
      expect(maxDelay).toBeLessThanOrEqual(1200);
    });
  });
});
