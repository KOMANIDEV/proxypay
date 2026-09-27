/**
 * Tests for Webhook Outbox Delivery Guarantee (#630)
 *
 * Covers:
 *  - processOutbox() marks entry as "processing" before sending
 *  - processOutbox() marks entry as "delivered" only after 2xx ACK
 *  - processOutbox() re-queues entry with backoff on delivery failure
 *  - processOutbox() moves entry to DLQ after maxAttempts exhausted
 *  - processOutbox() calls outboxModel.moveToDLQ() when available
 *  - processOutbox() re-queues entries stuck in "processing" past ackDeadlineAt
 *  - processOutbox() moves stuck entries to DLQ when attempts exhausted
 *  - ackTimeoutMs is configurable
 */

import { WebhookService, WebhookOutboxEntry, WebhookOutboxModel } from "../../services/webhook";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<WebhookOutboxEntry> = {}): WebhookOutboxEntry {
  return {
    id: "entry-1",
    eventType: "transaction.completed",
    payload: {
      event: "transaction.completed",
      timestamp: new Date().toISOString(),
      data: { id: "txn-1" },
    } as any,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    createdAt: new Date(),
    compress: false,
    ...overrides,
  };
}

function makeOutboxModel(entries: WebhookOutboxEntry[]): WebhookOutboxModel & {
  updates: Array<{ id: string; update: Partial<WebhookOutboxEntry> }>;
  dlqEntries: Array<{ id: string; reason: string }>;
} {
  const updates: Array<{ id: string; update: Partial<WebhookOutboxEntry> }> = [];
  const dlqEntries: Array<{ id: string; reason: string }> = [];

  return {
    updates,
    dlqEntries,
    async insert() { return "new-id"; },
    async findNextToProcess() { return [...entries]; },
    async update(id, update) { updates.push({ id, update }); },
    async delete() {},
    async moveToDLQ(id, reason) { dlqEntries.push({ id, reason }); },
  };
}

function makeService(fetchImpl: jest.Mock, ackTimeoutMs = 60_000) {
  return new WebhookService({
    fetchImpl: fetchImpl as any,
    webhookUrl: "https://example.com/webhook",
    webhookSecret: "test-secret",
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterFactor: 0,
    sleep: () => Promise.resolve(),
    ackTimeoutMs,
  });
}

// ---------------------------------------------------------------------------
// processOutbox — happy path
// ---------------------------------------------------------------------------

describe("processOutbox() — ACK on 2xx response", () => {
  it("marks entry as 'processing' before sending, then 'delivered' on ACK", async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    const entry = makeEntry();
    const model = makeOutboxModel([entry]);
    const service = makeService(mockFetch);

    const { processed, failures } = await service.processOutbox(model as any);

    expect(processed).toBe(1);
    expect(failures).toBe(0);

    // First update should set status to "processing"
    const processingUpdate = model.updates.find((u) => u.update.status === "processing");
    expect(processingUpdate).toBeDefined();
    expect(processingUpdate!.update.ackDeadlineAt).toBeInstanceOf(Date);

    // Final update should set status to "delivered"
    const deliveredUpdate = model.updates.find((u) => u.update.status === "delivered");
    expect(deliveredUpdate).toBeDefined();
    expect(deliveredUpdate!.update.ackDeadlineAt).toBeUndefined();
  });

  it("does NOT mark delivered on non-2xx response — re-queues instead", async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 500 });
    const entry = makeEntry();
    const model = makeOutboxModel([entry]);
    const service = makeService(mockFetch);

    const { processed, failures } = await service.processOutbox(model as any);

    expect(processed).toBe(0);
    expect(failures).toBe(1);

    const delivered = model.updates.find((u) => u.update.status === "delivered");
    expect(delivered).toBeUndefined();

    const pending = model.updates.find((u) => u.update.status === "pending");
    expect(pending).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// processOutbox — retry and DLQ
// ---------------------------------------------------------------------------

describe("processOutbox() — retry on failure", () => {
  it("re-queues with backoff when delivery fails and attempts < maxAttempts", async () => {
    const mockFetch = jest.fn().mockRejectedValueOnce(new Error("network error"));
    const entry = makeEntry({ attempts: 1 }); // 1 attempt already, 2 remaining
    const model = makeOutboxModel([entry]);
    const service = makeService(mockFetch);

    await service.processOutbox(model as any);

    const pendingUpdate = model.updates.find((u) => u.update.status === "pending");
    expect(pendingUpdate).toBeDefined();
    expect(pendingUpdate!.update.attempts).toBe(2);
    expect(pendingUpdate!.update.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("moves to DLQ via moveToDLQ() after maxAttempts exhausted", async () => {
    const mockFetch = jest.fn().mockRejectedValueOnce(new Error("permanent failure"));
    const entry = makeEntry({ attempts: 2, maxAttempts: 3 }); // 2 done, 1 remaining = exhausted
    const model = makeOutboxModel([entry]);
    const service = makeService(mockFetch);

    await service.processOutbox(model as any);

    expect(model.dlqEntries).toHaveLength(1);
    expect(model.dlqEntries[0].id).toBe("entry-1");
    expect(model.dlqEntries[0].reason).toMatch(/Exhausted retries/i);
  });

  it("marks as 'failed' when DLQ handler is not available", async () => {
    const mockFetch = jest.fn().mockRejectedValueOnce(new Error("permanent failure"));
    const entry = makeEntry({ attempts: 2, maxAttempts: 3 });
    const model = makeOutboxModel([entry]);
    // Remove moveToDLQ
    delete (model as any).moveToDLQ;

    const service = makeService(mockFetch);
    await service.processOutbox(model as any);

    const failedUpdate = model.updates.find((u) => u.update.status === "failed");
    expect(failedUpdate).toBeDefined();
    expect(model.dlqEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// processOutbox — ACK timeout recovery
// ---------------------------------------------------------------------------

describe("processOutbox() — ACK timeout recovery", () => {
  it("re-queues entries stuck in 'processing' past their ackDeadlineAt", async () => {
    const mockFetch = jest.fn(); // should not be called for timeout re-queue
    const stuckEntry = makeEntry({
      status: "processing",
      attempts: 1,
      ackDeadlineAt: new Date(Date.now() - 5000), // 5 seconds past deadline
    });
    const model = makeOutboxModel([stuckEntry]);
    const service = makeService(mockFetch);

    const { failures } = await service.processOutbox(model as any);

    // The stuck entry should be re-queued (failures incremented to alert operator)
    expect(failures).toBe(1);
    // No new fetch should have been made for the stuck entry
    expect(mockFetch).not.toHaveBeenCalled();

    const pendingUpdate = model.updates.find((u) => u.update.status === "pending");
    expect(pendingUpdate).toBeDefined();
    expect(pendingUpdate!.update.attempts).toBe(2);
  });

  it("moves to DLQ when stuck entry has exhausted maxAttempts", async () => {
    const mockFetch = jest.fn();
    const stuckEntry = makeEntry({
      status: "processing",
      attempts: 2,
      maxAttempts: 3,
      ackDeadlineAt: new Date(Date.now() - 5000),
    });
    const model = makeOutboxModel([stuckEntry]);
    const service = makeService(mockFetch);

    await service.processOutbox(model as any);

    expect(model.dlqEntries).toHaveLength(1);
    expect(model.dlqEntries[0].reason).toMatch(/ACK timeout/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT re-queue entries whose ackDeadlineAt is in the future", async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    const processingEntry = makeEntry({
      status: "processing",
      attempts: 1,
      ackDeadlineAt: new Date(Date.now() + 60_000), // 60s in future — still valid
    });
    // findNextToProcess returns the entry; it should be processed normally
    const model = makeOutboxModel([processingEntry]);
    const service = makeService(mockFetch);

    // The entry is "processing" but deadline hasn't passed — service should
    // attempt delivery and mark delivered on ACK.
    const { processed } = await service.processOutbox(model as any);
    // Because the entry is already "processing" but within deadline, the service
    // will attempt a new send (idempotent retry).
    expect(processed).toBe(1);
  });

  it("ackTimeoutMs is configurable", async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    const entry = makeEntry();
    const model = makeOutboxModel([entry]);
    const service = makeService(mockFetch, 5_000); // 5 second ACK window

    await service.processOutbox(model as any);

    const processingUpdate = model.updates.find((u) => u.update.status === "processing");
    const deadline = processingUpdate?.update?.ackDeadlineAt;
    if (deadline) {
      const msDiff = deadline.getTime() - Date.now();
      // Deadline should be roughly 5 seconds from now (allow ±2s for test execution)
      expect(msDiff).toBeGreaterThan(3_000);
      expect(msDiff).toBeLessThan(7_000);
    }
  });
});
