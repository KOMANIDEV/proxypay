import { ParallelBatchProcessor, CircuitBreakerState, BatchItem } from "../src/services/parallelBatchProcessor";
import { WebhookRetryPolicyService } from "../src/services/webhookRetryPolicyService";

describe("WebhookRetryPolicyService", () => {
  describe("ParallelBatchProcessor integration", () => {
    it("should process all items in a batch", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 3,
        rateLimitPerSecond: 100,
      });

      const items: BatchItem<number>[] = Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        payload: i,
      }));

      const processed: number[] = [];
      const summary = await processor.processBatch(items, async (item) => {
        processed.push(item.payload);
        return item.payload * 2;
      });

      expect(summary.total).toBe(10);
      expect(summary.succeeded).toBe(10);
      expect(summary.failed).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(processed).toHaveLength(10);
    });

    it("should handle processor failures gracefully", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 2,
        rateLimitPerSecond: 100,
        maxRetries: 0,
        circuitBreakerThreshold: 5,
      });

      const items: BatchItem<string>[] = [
        { id: "ok-1", payload: "ok" },
        { id: "fail-1", payload: "fail" },
        { id: "ok-2", payload: "ok" },
      ];

      const summary = await processor.processBatch(items, async (item) => {
        if (item.payload === "fail") {
          throw new Error("Intentional failure");
        }
        return "success";
      });

      expect(summary.total).toBe(3);
      expect(summary.succeeded).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.results.find(r => r.item.id === "fail-1")?.success).toBe(false);
      expect(summary.results.find(r => r.item.id === "fail-1")?.error).toBe("Intentional failure");
    });

    it("should retry failed items when maxRetries > 0", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 100,
        maxRetries: 2,
        circuitBreakerThreshold: 10,
      });

      let attemptCount = 0;
      const items: BatchItem<string>[] = [
        { id: "retry-item", payload: "data" },
      ];

      const summary = await processor.processBatch(items, async (item) => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error("Temporary failure");
        }
        return "success on retry";
      });

      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(0);
      expect(attemptCount).toBe(3);
    });

    it("should trip circuit breaker after consecutive failures", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 100,
        maxRetries: 0,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 50000,
      });

      const items: BatchItem<string>[] = Array.from({ length: 10 }, (_, i) => ({
        id: `fail-${i}`,
        payload: "fail",
      }));

      const summary = await processor.processBatch(items, async () => {
        throw new Error("Always fails");
      });

      expect(summary.circuitBreakerTripped).toBe(true);
      expect(summary.failed + summary.skipped).toBe(10);
      expect(processor.getState()).toBe(CircuitBreakerState.Open);
    });

    it("should reset circuit breaker after timeout", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 100,
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitBreakerResetMs: 100,
      });

      // Trip the breaker
      const failItems: BatchItem<string>[] = Array.from({ length: 3 }, (_, i) => ({
        id: `fail-${i}`,
        payload: "fail",
      }));

      await processor.processBatch(failItems, async () => {
        throw new Error("Always fails");
      });

      expect(processor.getState()).toBe(CircuitBreakerState.Open);

      // Wait for reset
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should be half-open now, process should succeed
      const okItems: BatchItem<string>[] = [
        { id: "ok-1", payload: "ok" },
      ];

      const summary = await processor.processBatch(okItems, async () => "success");
      expect(summary.succeeded).toBe(1);
      expect(processor.getState()).toBe(CircuitBreakerState.Closed);
    });

    it("should enforce rate limiting", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 10,
        rateLimitPerSecond: 5,
        circuitBreakerThreshold: 100,
      });

      const items: BatchItem<number>[] = Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        payload: i,
      }));

      const start = Date.now();
      const summary = await processor.processBatch(items, async (item) => {
        return item.payload;
      });

      expect(summary.total).toBe(10);
      expect(summary.succeeded).toBe(10);
      // With rate limit of 5/sec and 10 items, should take at least ~1 second
      expect(Date.now() - start).toBeGreaterThanOrEqual(800);
    });

    it("should manually reset circuit breaker", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 100,
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitBreakerResetMs: 60000,
      });

      // Trip the breaker
      const items: BatchItem<string>[] = Array.from({ length: 3 }, (_, i) => ({
        id: `fail-${i}`,
        payload: "fail",
      }));

      await processor.processBatch(items, async () => {
        throw new Error("Always fails");
      });

      expect(processor.getState()).toBe(CircuitBreakerState.Open);

      processor.resetCircuitBreaker();

      expect(processor.getState()).toBe(CircuitBreakerState.Closed);
      expect(processor.getConsecutiveFailures()).toBe(0);
    });

    it("should return correct metadata in results", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 100,
        maxRetries: 0,
        circuitBreakerThreshold: 100,
      });

      const items: BatchItem<string>[] = [
        { id: "item-1", payload: "data" },
      ];

      const summary = await processor.processBatch(items, async (item) => {
        return { processed: true };
      });

      expect(summary.results[0].item.id).toBe("item-1");
      expect(summary.results[0].success).toBe(true);
      expect(summary.results[0].result).toEqual({ processed: true });
      expect(summary.results[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
