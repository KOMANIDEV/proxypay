/**
 * Session Request Queue — Issue #631
 *
 * Mobile money web-session providers (Orange Money, Airtel Money) authenticate a
 * single stateful session and then send every operation through it. Firing
 * concurrent requests at the same session corrupts the cookie/CSRF state and
 * causes spurious "session expired" responses.
 *
 * `SessionRequestQueue` provides:
 *  - request queueing per session (FIFO)
 *  - a serialization lock so only one session request runs at a time
 *  - detection of sessions that expire while a request is still queued
 */

import logger from "../../utils/logger";

/**
 * Raised when a queued request reaches the front of the queue but the session
 * it was bound to has already expired. Callers are expected to re-authenticate
 * (force a fresh login) and retry the request once.
 */
export class SessionTimeoutError extends Error {
  readonly sessionKey: string;
  readonly waitedMs: number;

  constructor(sessionKey: string, waitedMs: number) {
    super(
      `Session "${sessionKey}" expired while the request waited in the queue (${waitedMs}ms)`,
    );
    this.name = "SessionTimeoutError";
    this.sessionKey = sessionKey;
    this.waitedMs = waitedMs;
  }
}

/** Raised when a session queue is already holding `maxQueueDepth` waiting requests. */
export class SessionQueueOverflowError extends Error {
  readonly sessionKey: string;
  readonly maxQueueDepth: number;

  constructor(sessionKey: string, maxQueueDepth: number) {
    super(
      `Session "${sessionKey}" request queue is full (max ${maxQueueDepth} waiting requests)`,
    );
    this.name = "SessionQueueOverflowError";
    this.sessionKey = sessionKey;
    this.maxQueueDepth = maxQueueDepth;
  }
}

export interface SessionRequestOptions {
  /**
   * Session expiry (epoch ms) the queued request is bound to. When set, the
   * request is rejected with `SessionTimeoutError` if the session expired
   * before the request could start (i.e. while it was queued).
   */
  sessionExpiresAt?: number;
  /** Optional operation label used for structured logging. */
  operation?: string;
}

export interface SessionRequestQueueOptions {
  /** Maximum requests allowed to wait per session (running request excluded). Default 100. */
  maxQueueDepth?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  clock?: () => number;
  /** Callback fired whenever a queued request is dropped because its session expired. */
  onSessionTimeout?: (sessionKey: string, waitedMs: number) => void;
  /** Callback fired whenever a request is rejected because the queue is full. */
  onQueueOverflow?: (sessionKey: string, maxQueueDepth: number) => void;
}

interface QueueEntry {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  options: SessionRequestOptions;
  enqueuedAt: number;
}

interface SessionQueueState {
  /** Promise chain acting as the serialization lock for this session. */
  tail: Promise<void>;
  /** Requests waiting for the lock, in FIFO order. */
  pending: QueueEntry[];
  /** True while a request is executing under the lock. */
  locked: boolean;
}

export interface SessionQueueStats {
  sessionKey: string;
  waiting: number;
  locked: boolean;
}


const DEFAULT_MAX_QUEUE_DEPTH = 100;

export class SessionRequestQueue {
  private readonly queues = new Map<string, SessionQueueState>();
  private readonly maxQueueDepth: number;
  private readonly clock: () => number;
  private readonly onSessionTimeout?: (
    sessionKey: string,
    waitedMs: number,
  ) => void;
  private readonly onQueueOverflow?: (
    sessionKey: string,
    maxQueueDepth: number,
  ) => void;

  constructor(options: SessionRequestQueueOptions = {}) {
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.clock = options.clock ?? Date.now;
    this.onSessionTimeout = options.onSessionTimeout;
    this.onQueueOverflow = options.onQueueOverflow;
  }

  /**
   * Queue `task` behind any in-flight requests for `sessionKey` and run it once
   * the session lock is free. The returned promise settles with the task's
   * result (or error) and never with another queued request's outcome.
   */
  enqueue<T>(
    sessionKey: string,
    task: () => Promise<T>,
    options: SessionRequestOptions = {},
  ): Promise<T> {
    const state = this.getOrCreateState(sessionKey);

    if (state.pending.length >= this.maxQueueDepth) {
      this.onQueueOverflow?.(sessionKey, this.maxQueueDepth);
      logger.warn(
        { sessionKey, maxQueueDepth: this.maxQueueDepth },
        "Session request queue overflow — rejecting request",
      );
      return Promise.reject(
        new SessionQueueOverflowError(sessionKey, this.maxQueueDepth),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        run: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        options,
        enqueuedAt: this.clock(),
      };

      state.pending.push(entry);
      // Chain onto the tail so the lock is only released before the next run.
      state.tail = state.tail.then(() =>
        this.runEntry(sessionKey, state, entry),
      );
    });
  }

  /** Number of requests currently waiting for the session lock. */
  size(sessionKey: string): number {
    return this.queues.get(sessionKey)?.pending.length ?? 0;
  }

  /** True while a request is executing under the session lock. */
  isLocked(sessionKey: string): boolean {
    return this.queues.get(sessionKey)?.locked ?? false;
  }

  /** Snapshot of every tracked session queue (used for metrics/diagnostics). */
  stats(): SessionQueueStats[] {
    return Array.from(this.queues.entries()).map(([sessionKey, state]) => ({
      sessionKey,
      waiting: state.pending.length,
      locked: state.locked,
    }));
  }

  /**
   * Drop every queued (not yet started) request for a session. Each dropped
   * request is rejected with `SessionTimeoutError` so callers can re-login.
   */
  clear(sessionKey: string): void {
    const state = this.queues.get(sessionKey);
    if (!state) return;

    const dropped = state.pending.splice(0, state.pending.length);
    for (const entry of dropped) {
      const waitedMs = this.clock() - entry.enqueuedAt;
      this.onSessionTimeout?.(sessionKey, waitedMs);
      entry.reject(new SessionTimeoutError(sessionKey, waitedMs));
    }

    if (!state.locked) {
      this.queues.delete(sessionKey);
    }
  }

  private getOrCreateState(sessionKey: string): SessionQueueState {
    let state = this.queues.get(sessionKey);
    if (!state) {
      state = { tail: Promise.resolve(), pending: [], locked: false };
      this.queues.set(sessionKey, state);
    }
    return state;
  }

  private async runEntry(
    sessionKey: string,
    state: SessionQueueState,
    entry: QueueEntry,
  ): Promise<void> {
    const index = state.pending.indexOf(entry);
    if (index !== -1) {
      state.pending.splice(index, 1);
    }

    const waitedMs = this.clock() - entry.enqueuedAt;

    // Session timeout detection: the session may have expired while queued.
    if (
      entry.options.sessionExpiresAt !== undefined &&
      entry.options.sessionExpiresAt > 0 &&
      entry.options.sessionExpiresAt <= this.clock()
    ) {
      this.onSessionTimeout?.(sessionKey, waitedMs);
      logger.warn(
        {
          sessionKey,
          operation: entry.options.operation,
          waitedMs,
        },
        "Session expired while request was queued",
      );
      entry.reject(new SessionTimeoutError(sessionKey, waitedMs));
      this.release(sessionKey, state);
      return;
    }

    state.locked = true;
    try {
      const result = await entry.run();
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      state.locked = false;
      this.release(sessionKey, state);
    }
  }

  private release(sessionKey: string, state: SessionQueueState): void {
    if (!state.locked && state.pending.length === 0) {
      this.queues.delete(sessionKey);
    }
  }
}

export default SessionRequestQueue;

