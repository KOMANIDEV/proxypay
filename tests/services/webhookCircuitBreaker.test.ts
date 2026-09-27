import { WebhookService } from "../../src/services/webhook";
import {
  WebhookCircuitBreaker,
  WebhookCircuitBreakerRegistry,
} from "../../src/services/webhookCircuitBreaker";
import { Transaction, TransactionStatus } from "../../src/models/transaction";

jest.setTimeout(15000);

const makeTransaction = (): Transaction =>
  ({
    id: "txn_cb_1",
    referenceNumber: "REF-CB-001",
    type: "deposit",
    amount: "100.00",
    phoneNumber: "+1234567890",
    provider: "mpesa",
    stellarAddress: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
    status: TransactionStatus.Completed,
    tags: [],
    notes: "",
    userId: "user_1",
    metadata: {},
    createdAt: new Date("2026-03-27T11:45:00.000Z"),
    updatedAt: new Date("2026-03-27T11:45:00.000Z"),
  }) as unknown as Transaction;

describe("WebhookService circuit breaker lifecycle (#573)", () => {
  let mockFetch: jest.Mock;
  let breaker: WebhookCircuitBreaker;
  let service: WebhookService;
  let time: number;

  beforeEach(() => {
    jest.clearAllMocks();
    time = 1_000_000;
    mockFetch = jest.fn();
    breaker = new WebhookCircuitBreaker("https://example.test/hook", {
      failureThreshold: 2,
      recoveryTimeMs: 24 * 60 * 60 * 1000,
      now: () => time,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    service = new WebhookService({
      fetchImpl: mockFetch,
      webhookUrl: "https://example.test/hook",
      webhookSecret: "test-secret",
      maxAttempts: 1,
      circuitBreaker: breaker,
    });
  });

  const failDelivery = async () =>
    service.sendTransactionEvent("transaction.completed", makeTransaction());

  it("starts closed and records transitions open -> half_open -> closed", async () => {
    expect(breaker.getState()).toBe("closed");

    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await failDelivery();
    expect(breaker.getState()).toBe("closed"); // 1 failure < threshold 2

    await failDelivery();
    expect(breaker.getState()).toBe("open"); // threshold reached

    // Circuit open: deliveries are short-circuited without hitting fetch.
    const blocked = await failDelivery();
    expect(blocked.status).toBe("skipped");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // After the 24h recovery window the breaker half-opens and the probe succeeds.
    time += 24 * 60 * 60 * 1000;
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const recovered = await failDelivery();
    expect(recovered.status).toBe("delivered");
    expect(breaker.getState()).toBe("closed");
  });

  it("returns to open (fresh recovery window) when the half-open probe fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await failDelivery();
    await failDelivery();
    expect(breaker.getState()).toBe("open");

    time += 24 * 60 * 60 * 1000;
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await failDelivery();
    expect(breaker.getState()).toBe("open");
    expect(breaker.snapshot().openedAt).not.toBeNull();
  });

  it("manual reset() closes an open breaker and deliveries resume", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await failDelivery();
    await failDelivery();
    expect(breaker.getState()).toBe("open");

    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.getConsecutiveFailures()).toBe(0);

    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const result = await failDelivery();
    expect(result.status).toBe("delivered");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("records success and resets consecutive failures without a transition when closed", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await failDelivery();
    expect(breaker.getConsecutiveFailures()).toBe(1);

    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await failDelivery();
    expect(breaker.getConsecutiveFailures()).toBe(0);
    expect(breaker.getState()).toBe("closed");
  });

  it("processOutbox skips the whole batch while the circuit is open", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await failDelivery();
    await failDelivery();
    expect(breaker.getState()).toBe("open");

    const outboxModel = {
      insert: jest.fn(),
      findNextToProcess: jest.fn().mockResolvedValue([
        {
          id: "entry_1",
          eventType: "transaction.completed",
          payload: { event: "transaction.completed", timestamp: new Date().toISOString(), data: {} },
          status: "pending",
          attempts: 0,
          maxAttempts: 3,
          createdAt: new Date(),
        },
      ]),
      update: jest.fn(),
      delete: jest.fn(),
    };
    const summary = await service.processOutbox(outboxModel as any);
    expect(summary).toEqual({ processed: 0, failures: 0 });
    expect(outboxModel.update).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("registry reset() reaches the same instance used by WebhookService", async () => {
    // The default WebhookService creates its breaker via the shared registry.
    const shared = new WebhookService({
      fetchImpl: mockFetch,
      webhookUrl: "https://registry.test/hook",
      webhookSecret: "s",
      maxAttempts: 1,
      circuitBreakerFailureThreshold: 1,
    });
    const svcBreaker = shared.getWebhookCircuitBreaker();
    expect(svcBreaker).not.toBeNull();

    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await shared.sendTransactionEvent("transaction.completed", makeTransaction());
    expect(svcBreaker!.getState()).toBe("open");

    const reset = WebhookCircuitBreakerRegistry.reset("https://registry.test/hook");
    expect(reset).toBeDefined();
    expect(svcBreaker!.getState()).toBe("closed");
  });
});
