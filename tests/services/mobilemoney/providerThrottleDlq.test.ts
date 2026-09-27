/**
 * Provider throttle dead-letter queue tests (Issue #625).
 *
 * The throttle queue previously dropped requests silently when saturated.
 * These tests assert that dropped/failed requests are routed to a DLQ, logged
 * with full context, and can be listed and replayed by admins.
 */
jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    eval: jest.fn().mockResolvedValue([1, 0]),
    quit: jest.fn().mockResolvedValue("OK"),
    on: jest.fn(),
  }));
});

jest.mock("bullmq", () => {
  class MockQueue {
    jobs: any[] = [];
    constructor(public name: string) {
      const registry: Record<string, unknown> =
        (globalThis as any).__bullQueues ||
        ((globalThis as any).__bullQueues = {});
      registry[name] = this;
      this.add = jest.fn(async (_job: string, data: any, opts?: any) => ({
        id: `${name}-job-${this.jobs.length + 1}`,
        data,
        opts,
        remove: jest.fn(async () => undefined),
        waitUntilFinished: jest.fn(async () => ({ ok: true })),
      })) as any;
      this.getWaitingCount = jest.fn(async () => 0) as any;
      this.getActiveCount = jest.fn(async () => 0) as any;
      this.getDelayedCount = jest.fn(async () => 0) as any;
      this.getJobs = jest.fn(async () => []) as any;
      this.getJob = jest.fn(async () => null) as any;
      this.close = jest.fn(async () => undefined) as any;
    }
    add: any;
    getWaitingCount: any;
    getActiveCount: any;
    getDelayedCount: any;
    getJobs: any;
    getJob: any;
    close: any;
  }

  class MockQueueEvents {
    close = jest.fn(async () => undefined);
    on = jest.fn();
  }

  class MockWorker {
    close = jest.fn(async () => undefined);
    on = jest.fn();
  }

  return { Queue: MockQueue, QueueEvents: MockQueueEvents, Worker: MockWorker };
});

import logger from "../../../src/utils/logger";
import {
  enqueueProviderCall,
  ProviderThrottleQueueFullError,
  listDeadLetters,
  getDeadLetterCount,
  replayDeadLetter,
} from "../../../src/services/mobilemoney/providerThrottle";

const queues = () => (globalThis as any).__bullQueues as Record<string, any>;

const MAIN = "mobile-money-provider-calls";

describe("providerThrottle dead-letter queue (#625)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "production";
    process.env.PROVIDER_THROTTLING_ENABLED = "true";
    process.env.PROVIDER_THROTTLE_MAX_QUEUE_SIZE = "2";
    const registry = queues();
    for (const name of [MAIN, DLQ]) {
      const q = registry[name];
      q.getWaitingCount.mockResolvedValue(0);
      q.getActiveCount.mockResolvedValue(0);
      q.getDelayedCount.mockResolvedValue(0);
      q.getJobs.mockResolvedValue([]);
      q.getJob.mockResolvedValue(null);
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("queues the request when the queue is below capacity", async () => {
    const result = await enqueueProviderCall(paymentCall);

    expect(result).toEqual({ ok: true });
    expect(queues()[MAIN].add).toHaveBeenCalledWith(
      "provider-call",
      paymentCall,
      expect.objectContaining({ attempts: expect.any(Number) }),
    );
    expect(queues()[DLQ].add).not.toHaveBeenCalled();
  });

  it("dead-letters the request and throws when the queue is saturated", async () => {
    queues()[MAIN].getWaitingCount.mockResolvedValue(5);
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => logger);

    await expect(enqueueProviderCall(paymentCall)).rejects.toBeInstanceOf(
      ProviderThrottleQueueFullError,
    );

    expect(queues()[DLQ].add).toHaveBeenCalledWith(
      "dead-letter",
      expect.objectContaining({
        provider: "mtn",
        operation: "payment",
        payload: paymentCall,
        reason: expect.stringContaining("full"),
        failedAt: expect.any(String),
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "provider_throttle_dead_letter",
        provider: "mtn",
        payload: paymentCall,
        timestamp: expect.any(String),
      }),
      "[providerThrottle] request moved to dead-letter queue",
    );
    errorSpy.mockRestore();
  });

  it("attaches the dead-letter id to the thrown error", async () => {
    queues()[MAIN].getWaitingCount.mockResolvedValue(2);

    await expect(enqueueProviderCall(paymentCall)).rejects.toMatchObject({
      name: "ProviderThrottleQueueFullError",
      deadLetterId: expect.any(String),
    });
  });

  it("lists dead-letter entries with their job id", async () => {
    queues()[DLQ].getJobs.mockResolvedValue([
      {
        id: "dlq-1",
        data: {
          provider: "mtn",
          operation: "payment",
          payload: paymentCall,
          reason: "queue full",
          failedAt: "2026-01-01T00:00:00.000Z",
          attemptsMade: 0,
        },
      },
    ]);

    const items = await listDeadLetters(10);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "dlq-1", provider: "mtn" });
  });

  it("reports the dead-letter count", async () => {
    queues()[DLQ].getWaitingCount.mockResolvedValue(7);
    await expect(getDeadLetterCount()).resolves.toBe(7);
  });

  it("replays a dead-letter item and removes it from the DLQ", async () => {
    const remove = jest.fn(async () => undefined);
    queues()[DLQ].getJob.mockResolvedValue({
      id: "dlq-1",
      data: { provider: "mtn", payload: paymentCall },
      remove,
    });

    const result = await replayDeadLetter("dlq-1");

    expect(result).toEqual({ replayed: true, deadLetterId: "dlq-1" });
    expect(queues()[MAIN].add).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it("reports failure when the dead-letter item does not exist", async () => {
    const result = await replayDeadLetter("missing");

    expect(result.replayed).toBe(false);
    expect(result.error).toContain("not found");
  });
});

const DLQ = "mobile-money-provider-calls-dlq";

const paymentCall = {
  operation: "payment" as const,
  provider: "mtn",
  phoneNumber: "+237670000000",
  amount: "10",
};
