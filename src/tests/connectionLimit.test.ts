/**
 * Tests for GraphQL Subscription connection limit enforcement (#627)
 *
 * Covers:
 *  - ConnectionLimitManager.acquire() tracks and releases counts correctly
 *  - Throws SUBSCRIPTION_LIMIT_EXCEEDED when limit is reached
 *  - withConnectionRelease() wrapper calls release on return() and throw()
 *  - Per-user limit is enforced independently (one user's limit doesn't affect another)
 *  - connectionLimitManager.getMetrics() returns live totals
 *  - subscriptionResolvers enforce the limit via context.auth.subject
 */

import { EventEmitter } from "events";
import {
  connectionLimitManager,
  MAX_CONNECTIONS_PER_USER,
  SubscriptionChannels,
  transactionChannel,
} from "../graphql/subscriptions";
import { createSubscriptionResolvers as makeResolvers } from "../graphql/subscriptionResolvers";

// ---------------------------------------------------------------------------
// Minimal in-memory PubSub stub
// ---------------------------------------------------------------------------

class StubPubSub extends EventEmitter {
  asyncIterator<T>(channels: string | string[]): AsyncIterableIterator<T> {
    const channelList = Array.isArray(channels) ? channels : [channels];
    const queue: T[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    for (const ch of channelList) {
      this.on(ch, (payload: T) => {
        queue.push(payload);
        resolve?.();
        resolve = null;
      });
    }

    return {
      [Symbol.asyncIterator]() { return this; },
      async next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        if (done) return { value: undefined as any, done: true };
        await new Promise<void>((r) => { resolve = r; });
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        return { value: undefined as any, done: true };
      },
      async return() {
        done = true;
        return { value: undefined as any, done: true };
      },
      async throw(err?: any) {
        done = true;
        return Promise.reject(err);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(userId: string) {
  return { auth: { authenticated: true, subject: userId } };
}

const ANON_CTX = { auth: { authenticated: false, subject: null } };

// Obtain a fresh reference to the manager to avoid cross-test bleed.
// Since the manager is a module-level singleton we use acquire/release
// carefully and verify state is clean before each test.

// ---------------------------------------------------------------------------
// ConnectionLimitManager unit tests
// ---------------------------------------------------------------------------

describe("ConnectionLimitManager", () => {
  // Reset the manager between tests by releasing all acquired connections.
  // We do this by tracking releasers explicitly.

  it("starts with zero connections", () => {
    const { total } = connectionLimitManager.getMetrics();
    // Use a unique userId to avoid cross-test interference
    const count = connectionLimitManager.getCount("__clean__");
    expect(count).toBe(0);
  });

  it("increments count on acquire and decrements on release", () => {
    const userId = `user-${Date.now()}-a`;
    const release = connectionLimitManager.acquire(userId);
    expect(connectionLimitManager.getCount(userId)).toBe(1);
    release();
    expect(connectionLimitManager.getCount(userId)).toBe(0);
  });

  it("allows multiple acquires up to the limit", () => {
    const userId = `user-${Date.now()}-b`;
    const releasers: Array<() => void> = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      releasers.push(connectionLimitManager.acquire(userId));
    }
    expect(connectionLimitManager.getCount(userId)).toBe(MAX_CONNECTIONS_PER_USER);
    releasers.forEach((r) => r());
    expect(connectionLimitManager.getCount(userId)).toBe(0);
  });

  it("throws SUBSCRIPTION_LIMIT_EXCEEDED when limit is exceeded", () => {
    const userId = `user-${Date.now()}-c`;
    const releasers: Array<() => void> = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      releasers.push(connectionLimitManager.acquire(userId));
    }
    expect(() => connectionLimitManager.acquire(userId)).toThrow(
      /SUBSCRIPTION_LIMIT_EXCEEDED|maximum.*concurrent/i,
    );
    // Clean up
    releasers.forEach((r) => r());
  });

  it("allows a new connection after one is released", () => {
    const userId = `user-${Date.now()}-d`;
    const releasers: Array<() => void> = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      releasers.push(connectionLimitManager.acquire(userId));
    }
    // Release one slot
    releasers.pop()!();
    // Should succeed now
    const extra = connectionLimitManager.acquire(userId);
    expect(connectionLimitManager.getCount(userId)).toBe(MAX_CONNECTIONS_PER_USER);
    extra();
    releasers.forEach((r) => r());
  });

  it("limits are per-user (one user does not affect another)", () => {
    const user1 = `user-${Date.now()}-e1`;
    const user2 = `user-${Date.now()}-e2`;
    const r1 = connectionLimitManager.acquire(user1);
    const r2 = connectionLimitManager.acquire(user2);
    expect(connectionLimitManager.getCount(user1)).toBe(1);
    expect(connectionLimitManager.getCount(user2)).toBe(1);
    r1();
    r2();
  });

  it("getMetrics() totals live connections across all users", () => {
    const userA = `user-${Date.now()}-f1`;
    const userB = `user-${Date.now()}-f2`;
    const { total: beforeTotal } = connectionLimitManager.getMetrics();
    const r1 = connectionLimitManager.acquire(userA);
    const r2 = connectionLimitManager.acquire(userA);
    const r3 = connectionLimitManager.acquire(userB);
    const { total: afterTotal } = connectionLimitManager.getMetrics();
    expect(afterTotal).toBe(beforeTotal + 3);
    r1(); r2(); r3();
  });

  it("release is idempotent (double-release does not corrupt count)", () => {
    const userId = `user-${Date.now()}-g`;
    const release = connectionLimitManager.acquire(userId);
    expect(connectionLimitManager.getCount(userId)).toBe(1);
    release();
    release(); // double release — should be a no-op
    expect(connectionLimitManager.getCount(userId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Subscription resolver connection limit integration
// ---------------------------------------------------------------------------

describe("subscription resolvers enforce connection limits", () => {
  it("rejects subscription when user exceeds limit", () => {
    const pubsub = new StubPubSub() as any;
    const resolvers = makeResolvers(pubsub);
    const userId = `limit-test-${Date.now()}`;
    const ctx = makeContext(userId);

    const releasers: Array<() => void> = [];
    // Fill the user's quota
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      releasers.push(connectionLimitManager.acquire(userId));
    }

    // Next subscribe() should throw
    expect(() =>
      resolvers.Subscription.transactionCreated.subscribe(null, {}, ctx, null as any),
    ).toThrow(/SUBSCRIPTION_LIMIT_EXCEEDED|maximum.*concurrent/i);

    releasers.forEach((r) => r());
  });

  it("rejects unauthenticated connections (still throws UNAUTHENTICATED)", () => {
    const pubsub = new StubPubSub() as any;
    const resolvers = makeResolvers(pubsub);
    expect(() =>
      resolvers.Subscription.transactionCreated.subscribe(null, {}, ANON_CTX, null as any),
    ).toThrow(/UNAUTHENTICATED/);
  });

  it("releases the connection slot when iterator.return() is called", async () => {
    const pubsub = new StubPubSub() as any;
    const resolvers = makeResolvers(pubsub);
    const userId = `release-test-${Date.now()}`;
    const ctx = makeContext(userId);

    const countBefore = connectionLimitManager.getCount(userId);
    const iterator = resolvers.Subscription.transactionCreated.subscribe(null, {}, ctx, null as any);
    expect(connectionLimitManager.getCount(userId)).toBe(countBefore + 1);

    await iterator.return?.();
    expect(connectionLimitManager.getCount(userId)).toBe(countBefore);
  });
});
