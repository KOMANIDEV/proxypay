import { getRedisPubSub } from "./redisPubSub";
import type { PubSub } from "graphql-subscriptions";

// ---------------------------------------------------------------------------
// Singleton pubsub — Redis-backed in production, in-memory in tests
// ---------------------------------------------------------------------------

export const pubsub = getRedisPubSub();

// ---------------------------------------------------------------------------
// Per-user connection limit enforcement (#627)
//
// Tracks active GraphQL subscription connections per user. When a user exceeds
// MAX_CONNECTIONS_PER_USER (default 10) concurrent subscriptions the new
// connection is rejected immediately, preventing resource exhaustion.
//
// Usage — call from every subscription subscribe() handler:
//
//   const release = connectionLimitManager.acquire(context.auth.userId);
//   // release() is called when the iterator is garbage-collected / return()'d
// ---------------------------------------------------------------------------

/** Maximum concurrent GraphQL subscriptions allowed per user. */
export const MAX_CONNECTIONS_PER_USER = parseInt(
  process.env.GRAPHQL_SUBSCRIPTION_MAX_CONNECTIONS_PER_USER ?? "10",
  10,
);

export interface ConnectionMetrics {
  /** Live per-user connection counts (user → count). */
  readonly connections: ReadonlyMap<string, number>;
  /** Total active connections across all users. */
  readonly total: number;
}

class ConnectionLimitManager {
  /** userId → active subscription count */
  private readonly counts = new Map<string, number>();
  /** Monotonically-increasing bytes-approximation per connection (for tests/metrics) */
  private readonly memoryEstimateBytes = new Map<string, number>();

  /**
   * Attempts to register a new subscription connection for `userId`.
   *
   * @param userId — authenticated user id
   * @param estimatedMemoryBytes — optional per-subscription memory estimate
   *        (used for metrics only; does not gate connection)
   * @returns a release function that MUST be called when the subscription ends
   * @throws Error with code `SUBSCRIPTION_LIMIT_EXCEEDED` when the user has
   *         reached MAX_CONNECTIONS_PER_USER
   */
  acquire(userId: string, estimatedMemoryBytes = 0): () => void {
    const current = this.counts.get(userId) ?? 0;
    if (current >= MAX_CONNECTIONS_PER_USER) {
      throw Object.assign(
        new Error(
          `Subscription limit exceeded: user ${userId} has reached the maximum of ${MAX_CONNECTIONS_PER_USER} concurrent subscriptions`,
        ),
        { code: "SUBSCRIPTION_LIMIT_EXCEEDED", userId, limit: MAX_CONNECTIONS_PER_USER },
      );
    }

    this.counts.set(userId, current + 1);
    const totalMem = (this.memoryEstimateBytes.get(userId) ?? 0) + estimatedMemoryBytes;
    this.memoryEstimateBytes.set(userId, totalMem);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.counts.get(userId) ?? 0;
      if (count <= 1) {
        this.counts.delete(userId);
        this.memoryEstimateBytes.delete(userId);
      } else {
        this.counts.set(userId, count - 1);
        const mem = this.memoryEstimateBytes.get(userId) ?? 0;
        this.memoryEstimateBytes.set(userId, Math.max(0, mem - estimatedMemoryBytes));
      }
    };
  }

  /**
   * Returns a snapshot of live connection metrics.
   * Useful for Prometheus / admin dashboards.
   */
  getMetrics(): ConnectionMetrics {
    let total = 0;
    for (const v of this.counts.values()) total += v;
    return { connections: new Map(this.counts), total };
  }

  /** Returns the current connection count for `userId`. */
  getCount(userId: string): number {
    return this.counts.get(userId) ?? 0;
  }
}

/** Singleton connection limit manager shared across all subscription resolvers. */
export const connectionLimitManager = new ConnectionLimitManager();

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export enum SubscriptionChannels {
  TRANSACTION_CREATED    = "transaction.created",
  TRANSACTION_UPDATED    = "transaction.updated",
  TRANSACTION_COMPLETED  = "transaction.completed",
  TRANSACTION_FAILED     = "transaction.failed",

  DISPUTE_CREATED        = "dispute.created",
  DISPUTE_UPDATED        = "dispute.updated",
  DISPUTE_NOTE_ADDED     = "dispute.note_added",

  BULK_IMPORT_JOB_UPDATED = "bulk_import_job.updated",
}

/**
 * Per-transaction channel — clients subscribe to this for targeted updates.
 * Using a dedicated channel per ID avoids broadcasting every update to every
 * subscriber and lets Redis fan-out only to interested connections.
 */
export function transactionChannel(id: string): string {
  return `TRANSACTION_UPDATED:${id}`;
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface TransactionCreatedPayload {
  id: string;
  referenceNumber: string;
  type: string;
  amount: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  status: string;
  tags: string[];
  createdAt: string;
}

export interface TransactionUpdatedPayload {
  id: string;
  referenceNumber: string;
  status: string;
  updatedAt: string;
  jobProgress?: number | null;
  phoneNumber?: string;
  provider?: string;
  stellarAddress?: string;
}

export interface TransactionCompletedPayload {
  id: string;
  referenceNumber: string;
  status: string;
  completedAt: string;
}

export interface TransactionFailedPayload {
  id: string;
  referenceNumber: string;
  status: string;
  failedAt: string;
  error?: string;
}

export interface DisputeCreatedPayload {
  id: string;
  transactionId: string;
  reason: string;
  status: string;
  reportedBy: string | null;
  createdAt: string;
}

export interface DisputeUpdatedPayload {
  id: string;
  status: string;
  assignedTo: string | null;
  resolution: string | null;
  updatedAt: string;
}

export interface DisputeNoteAddedPayload {
  id: string;
  disputeId: string;
  author: string;
  note: string;
  createdAt: string;
}

export interface BulkImportJobUpdatedPayload {
  jobId: string;
  status: string;
  progress: {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
  };
  errors: Array<{ row: number; error: string }>;
  completedAt: string | null;
}

// Type for the PubSub engine that includes asyncIterator
export type TypedPubSub = PubSub & {
  asyncIterator<T>(eventPaths: string | string[]): AsyncIterableIterator<T>;
  publish<T>(eventPath: string, payload: T): Promise<void>;
};
