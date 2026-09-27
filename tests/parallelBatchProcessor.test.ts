import { ParallelBatchProcessor, CircuitBreakerState, BatchItem } from "../src/services/parallelBatchProcessor";

describe("ParallelBatchProcessor", () => {
  describe("constructor", () => {
    it("should create processor with default options", () => {
      const processor = new ParallelBatchProcessor({});
      expect(processor.getState()).toBe(CircuitBreakerState.Closed);
      expect(processor.getConsecutiveFailures()).toBe(0);
    });

    it("should clamp concurrency to valid range", () => {
      const low = new ParallelBatchProcessor({ concurrency: 0 });
      const high = new ParallelBatchProcessor({ concurrency: 100 });

      // Both should work without error
      expect(low.getState()).toBe(CircuitBreakerState.Closed);
      expect(high.getState()).toBe(CircuitBreakerState.Closed);
    });
  });

  describe("processBatch", () => {
    it("should process items concurrently up to concurrency limit", async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const processor = new ParallelBatchProcessor({
        concurrency: 3,
        rateLimitPerSecond: 1000,
        circuitBreakerThreshold: 100,
      });

      const items: BatchItem<number>[] = Array.from({ length: 9 }, (_, i) => ({
        id: `item-${i}`,
        payload: i,
      }));

      await processor.processBatch(items, async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(resolve => setTimeout(resolve, 50));
        currentConcurrent--;
      });

      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(maxConcurrent).toBeGreaterThanOrEqual(1);
    });

    it("should return correct summary statistics", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 2,
        rateLimitPerSecond: 100,
        circuitBreakerThreshold: 100,
      });

      const items: BatchItem<string>[] = Array.from({ length: 5 }, (_, i) => ({
        id: `item-${i}`,
        payload: `data-${i}`,
      }));

      const summary = await processor.processBatch(items, async (item) => {
        return `processed-${item.payload}`;
      });

      expect(summary.total).toBe(5);
      expect(summary.succeeded).toBe(5);
      expect(summary.failed).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.circuitBreakerTripped).toBe(false);
      expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(summary.results).toHaveLength(5);
    });

    it("should handle empty batch", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 3,
        rateLimitPerSecond: 100,
      });

      const summary = await processor.processBatch([], async () => "ok");

      expect(summary.total).toBe(0);
      expect(summary.succeeded).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.results).toHaveLength(0);
    });

    it("should stop processing when circuit breaker trips", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 1000,
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitBreakerResetMs: 60000,
      });

      const items: BatchItem<string>[] = Array.from({ length: 20 }, (_, i) => ({
        id: `item-${i}`,
        payload: i < 5 ? "fail" : "ok",
      }));

      const summary = await processor.processBatch(items, async (item) => {
        if (item.payload === "fail") {
          throw new Error("fail");
        }
        return "ok";
      });

      expect(summary.circuitBreakerTripped).toBe(true);
      // After circuit breaker trips, remaining items are skipped
      expect(summary.failed + summary.skipped).toBeGreaterThanOrEqual(2);
    });

    it("should retry failed items when maxRetries is configured", async () => {
      const attemptCounts = new Map<string, number>();

      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 1000,
        maxRetries: 3,
        circuitBreakerThreshold: 100,
      });

      const items: BatchItem<string>[] = [
        { id: "flaky", payload: "flaky" },
      ];

      const summary = await processor.processBatch(items, async (item) => {
        const count = (attemptCounts.get(item.id) || 0) + 1;
        attemptCounts.set(item.id, count);
        if (count < 3) {
          throw new Error(`Attempt ${count} failed`);
        }
        return "success";
      });

      expect(summary.succeeded).toBe(1);
      expect(attemptCounts.get("flaky")).toBe(3);
    });

    it("should handle mixed success and failure", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 3,
        rateLimitPerSecond: 1000,
        maxRetries: 0,
        circuitBreakerThreshold: 100,
      });

      const items: BatchItem<number>[] = Array.from({ length: 6 }, (_, i) => ({
        id: `item-${i}`,
        payload: i,
      }));

      const summary = await processor.processBatch(items, async (item) => {
        if (item.payload % 2 === 0) {
          throw new Error("Even numbers fail");
        }
        return item.payload;
      });

      expect(summary.total).toBe(6);
      expect(summary.succeeded).toBe(3);
      expect(summary.failed).toBe(3);
    });

    it("should measure duration correctly", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 2,
        rateLimitPerSecond: 100,
        circuitBreakerThreshold: 100,
      });

      const items: BatchItem<string>[] = [
        { id: "item-1", payload: "data" },
      ];

      const start = Date.now();
      const summary = await processor.processBatch(items, async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return "ok";
      });
      const elapsed = Date.now() - start;

      expect(summary.totalDurationMs).toBeGreaterThanOrEqual(40);
      expect(summary.totalDurationMs).toBeLessThanOrEqual(elapsed + 100);
      expect(summary.results[0].durationMs).toBeGreaterThanOrEqual(40);
    });

    it("should include error messages in failed results", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 100,
        maxRetries: 0,
        circuitBreakerThreshold: 100,
      });

      const items: BatchItem<string>[] = [
        { id: "err-item", payload: "data" },
      ];

      const summary = await processor.processBatch(items, async () => {
        throw new Error("Custom error message");
      });

      expect(summary.results[0].error).toBe("Custom error message");
      expect(summary.results[0].success).toBe(false);
    });
  });

  describe("circuit breaker", () => {
    it("should track consecutive failures correctly", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 1000,
        maxRetries: 0,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 60000,
      });

      expect(processor.getConsecutiveFailures()).toBe(0);

      // Trip with 5 failures
      const items: BatchItem<string>[] = Array.from({ length: 5 }, (_, i) => ({
        id: `fail-${i}`,
        payload: "fail",
      }));

      await processor.processBatch(items, async () => {
        throw new Error("fail");
      });

      expect(processor.getConsecutiveFailures()).toBeGreaterThanOrEqual(5);
      expect(processor.getState()).toBe(CircuitBreakerState.Open);
    });

    it("should reset consecutive failures on success", async () => {
      const processor = new ParallelBatchProcessor({
        concurrency: 1,
        rateLimitPerSecond: 1000,
        maxRetries: 0,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 60000,
      });

      // Fail twice
      await processor.processBatch(
        [
          { id: "f1", payload: "fail" },
          { id: "f2", payload: "fail" },
        ],
        async (item) => {
          if (item.payload === "fail") throw new Error("fail");
          return "ok";
        },
      );

      expect(processor.getConsecutiveFailures()).toBe(2);

      // Succeed
      await processor.processBatch(
        [{ id: "ok", payload: "ok" }],
        async () => "ok",
      );

      expect(processor.getConsecutiveFailures()).toBe(0);
    });
  });
});
