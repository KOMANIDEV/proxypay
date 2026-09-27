/**
 * Tests for concurrent request handling in mobile money sessions (Issue #631).
 */

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  },
}));

import {
  SessionRequestQueue,
  SessionQueueOverflowError,
  SessionTimeoutError,
} from "../sessionRequestQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SessionRequestQueue", () => {
  it("serializes concurrent requests for the same session", async () => {
    const queue = new SessionRequestQueue();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      queue.enqueue("session-1", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(i);
        active -= 1;
        return i;
      }),
    );

    const results = await Promise.all(tasks);

    expect(maxActive).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it("does not start a queued request until the session lock is released", async () => {
    const queue = new SessionRequestQueue();
    const gate = deferred<void>();
    const started: string[] = [];

    const first = queue.enqueue("session-1", async () => {
      started.push("first");
      await gate.promise;
      return "first";
    });
    await flush();

    const second = queue.enqueue("session-1", async () => {
      started.push("second");
      return "second";
    });
    await flush();

    expect(started).toEqual(["first"]);
    expect(queue.isLocked("session-1")).toBe(true);
    expect(queue.size("session-1")).toBe(1);

    gate.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(started).toEqual(["first", "second"]);
  });

  it("allows different sessions to run concurrently", async () => {
    const queue = new SessionRequestQueue();
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    const started: string[] = [];

    const a = queue.enqueue("session-a", async () => {
      started.push("a");
      await gateA.promise;
      return "a";
    });
    const b = queue.enqueue("session-b", async () => {
      started.push("b");
      await gateB.promise;
      return "b";
    });

    await flush();
    expect(started.sort()).toEqual(["a", "b"]);

    gateA.resolve();
    gateB.resolve();
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
  });
  it("rejects a request whose session expires while it is queued", async () => {
    let now = 1_000;
    const onSessionTimeout = jest.fn();
    const queue = new SessionRequestQueue({
      clock: () => now,
      onSessionTimeout,
    });

    const gate = deferred<void>();
    const executed: string[] = [];

    const running = queue.enqueue(
      "session-1",
      async () => {
        executed.push("running");
        await gate.promise;
      },
      { sessionExpiresAt: 10_000 },
    );
    await flush();

    const queued = queue.enqueue(
      "session-1",
      async () => {
        executed.push("queued");
      },
      { sessionExpiresAt: 2_000 },
    );

    // Session expires before the queued request gets the lock.
    now = 3_000;
    gate.resolve();
    await running;

    await expect(queued).rejects.toBeInstanceOf(SessionTimeoutError);
    expect(executed).toEqual(["running"]);
    expect(onSessionTimeout).toHaveBeenCalledWith("session-1", 2_000);
  });

  it("rejects new requests when the per-session queue is full", async () => {
    const queue = new SessionRequestQueue({ maxQueueDepth: 2 });
    const gate = deferred<void>();

    const running = queue.enqueue("session-1", () => gate.promise);
    await flush();

    const second = queue.enqueue("session-1", async () => "second");
    const third = queue.enqueue("session-1", async () => "third");

    await expect(
      queue.enqueue("session-1", async () => "fourth"),
    ).rejects.toBeInstanceOf(SessionQueueOverflowError);

    gate.resolve();
    await running;
    await expect(second).resolves.toBe("second");
    await expect(third).resolves.toBe("third");
  });

  it("clear() rejects queued requests so callers can re-authenticate", async () => {
    const queue = new SessionRequestQueue();
    const gate = deferred<void>();

    const running = queue.enqueue("session-1", () => gate.promise);
    await flush();
    const queued = queue.enqueue("session-1", async () => "queued");

    queue.clear("session-1");
    await expect(queued).rejects.toBeInstanceOf(SessionTimeoutError);

    gate.resolve();
    await expect(running).resolves.toBeUndefined();
  });

  it("keeps processing queued requests after one fails", async () => {
    const queue = new SessionRequestQueue();

    const failing = queue.enqueue("session-1", async () => {
      throw new Error("boom");
    });
    const succeeding = queue.enqueue("session-1", async () => "ok");

    await expect(failing).rejects.toThrow("boom");
    await expect(succeeding).resolves.toBe("ok");
  });

  it("exposes queue statistics for the tracked sessions", async () => {
    const queue = new SessionRequestQueue();
    const gate = deferred<void>();

    const running = queue.enqueue("session-1", () => gate.promise);
    await flush();
    const queued = queue.enqueue("session-1", async () => "queued");

    const stats = queue.stats();
    expect(stats).toEqual([
      { sessionKey: "session-1", waiting: 1, locked: true },
    ]);

    gate.resolve();
    await running;
    await queued;
    expect(queue.stats()).toEqual([]);
  });
});

