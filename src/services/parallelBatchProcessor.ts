import logger from "../utils/logger";

export interface ParallelBatchProcessorOptions {
  concurrency: number;
  rateLimitPerSecond?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
  maxRetries?: number;
}

export interface BatchItem<T = unknown> {
  id: string;
  payload: T;
}

export interface BatchResult<T = unknown> {
  item: BatchItem<T>;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface BatchProcessingSummary<T = unknown> {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
  results: BatchResult<T>[];
  circuitBreakerTripped: boolean;
}

type ProcessorFn<T> = (item: BatchItem<T>) => Promise<unknown>;

export enum CircuitBreakerState {
  Closed = "closed",
  Open = "open",
  HalfOpen = "half_open",
}

export class ParallelBatchProcessor {
  private readonly concurrency: number;
  private readonly rateLimitPerSecond: number;
  private readonly maxRetries: number;
  private circuitBreakerThreshold: number;
  private circuitBreakerResetMs: number;
  private consecutiveFailures = 0;
  private circuitState: CircuitBreakerState = CircuitBreakerState.Closed;
  private circuitOpenedAt = 0;
  private tokens: number;
  private lastRefillAt = 0;

  constructor(options: ParallelBatchProcessorOptions) {
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 5, 50));
    this.rateLimitPerSecond = Math.max(1, options.rateLimitPerSecond ?? 100);
    this.maxRetries = Math.max(0, options.maxRetries ?? 0);
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 10;
    this.circuitBreakerResetMs = options.circuitBreakerResetMs ?? 60000;
    this.tokens = this.rateLimitPerSecond;
    this.lastRefillAt = Date.now();
  }

  getState(): CircuitBreakerState {
    return this.circuitState;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    const refill = Math.floor((elapsed / 1000) * this.rateLimitPerSecond);
    if (refill > 0) {
      this.tokens = Math.min(this.rateLimitPerSecond, this.tokens + refill);
      this.lastRefillAt = now;
    }
  }

  private async waitForToken(): Promise<void> {
    this.refillTokens();
    while (this.tokens <= 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.refillTokens();
    }
    this.tokens--;
  }

  private checkCircuitBreaker(): boolean {
    if (this.circuitState === CircuitBreakerState.Open) {
      const now = Date.now();
      if (now - this.circuitOpenedAt >= this.circuitBreakerResetMs) {
        this.circuitState = CircuitBreakerState.HalfOpen;
        return true;
      }
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.circuitState === CircuitBreakerState.HalfOpen) {
      this.circuitState = CircuitBreakerState.Closed;
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.circuitState === CircuitBreakerState.HalfOpen) {
      this.tripCircuitBreaker();
    } else if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.tripCircuitBreaker();
    }
  }

  private tripCircuitBreaker(): void {
    this.circuitState = CircuitBreakerState.Open;
    this.circuitOpenedAt = Date.now();
    logger.warn(
      { consecutiveFailures: this.consecutiveFailures, threshold: this.circuitBreakerThreshold },
      "Circuit breaker tripped",
    );
  }

  private async processSingleItem<T>(
    item: BatchItem<T>,
    processor: ProcessorFn<T>,
  ): Promise<BatchResult<T>> {
    const start = Date.now();
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (!this.checkCircuitBreaker()) {
        return {
          item,
          success: false,
          error: "Circuit breaker is open",
          durationMs: Date.now() - start,
        };
      }

      await this.waitForToken();

      try {
        const result = await processor(item);
        this.recordSuccess();
        return {
          item,
          success: true,
          result,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Unknown error";
        this.recordFailure();

        if (attempt < this.maxRetries) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    return {
      item,
      success: false,
      error: lastError,
      durationMs: Date.now() - start,
    };
  }

  async processBatch<T>(
    items: BatchItem<T>[],
    processor: ProcessorFn<T>,
  ): Promise<BatchProcessingSummary<T>> {
    const overallStart = Date.now();
    const results: BatchResult<T>[] = [];
    let circuitBreakerTripped = false;

    const queue = [...items];
    const inFlight: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      while (queue.length > 0) {
        if (!this.checkCircuitBreaker()) {
          circuitBreakerTripped = true;
          while (queue.length > 0) {
            const skipped = queue.shift()!;
            results.push({
              item: skipped,
              success: false,
              error: "Circuit breaker is open",
              durationMs: 0,
            });
          }
          return;
        }

        const item = queue.shift()!;
        const result = await this.processSingleItem(item, processor);
        results.push(result);
      }
    };

    for (let i = 0; i < this.concurrency && queue.length > 0; i++) {
      inFlight.push(processNext());
    }

    await Promise.all(inFlight);

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success && r.durationMs > 0).length;
    const skipped = results.filter((r) => !r.success && r.durationMs === 0).length;

    return {
      total: items.length,
      succeeded,
      failed,
      skipped,
      totalDurationMs: Date.now() - overallStart,
      results,
      circuitBreakerTripped,
    };
  }

  resetCircuitBreaker(): void {
    this.circuitState = CircuitBreakerState.Closed;
    this.consecutiveFailures = 0;
  }
}
