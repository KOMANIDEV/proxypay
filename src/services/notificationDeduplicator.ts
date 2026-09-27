import { createHash } from "crypto";
import { redisClient } from "../config/redis";

/**
 * Notification deduplication
 *
 * The same logical notification event (e.g. a transaction reaching
 * "completed") can be triggered through multiple paths — the queue worker
 * routes directly, while the notification worker reacts to Redis pub/sub
 * messages that `updateStatus()` publishes to both the broadcast and
 * per-transaction channels, and more than one process may be running.
 *
 * This helper claims a per-event key atomically so only the first caller
 * proceeds; everyone else within the dedup window is a duplicate.
 *
 * Failure policy: fail-open. If the dedup store is unavailable we fall back
 * to an in-process store, and if that is unavailable we let the notification
 * through — a duplicate is preferable to a missed notification.
 */

const DEFAULT_TTL_SECONDS = parseInt(
  process.env.NOTIFICATION_DEDUP_TTL_SECONDS || "300",
  10,
);

const DEDUP_KEY_PREFIX = "notif:dedup:";

/**
 * Builds a stable fingerprint for dedup keys, hashing the parts when no
 * entity identifier is available.
 */
export function hashDedupParts(
  parts: Array<string | undefined | null>,
): string {
  return createHash("sha256")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 24);
}

/** In-process SET NX equivalent — used when Redis is not connected. */
class InMemoryDeduplicator {
  private readonly store = new Map<string, number>(); // key -> expiry (ms)
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  tryAcquire(key: string): boolean {
    const now = Date.now();

    // Opportunistic cleanup to avoid unbounded growth.
    if (this.store.size >= 10_000) {
      for (const [storedKey, expiresAt] of this.store) {
        if (expiresAt <= now) this.store.delete(storedKey);
      }
    }

    const expiresAt = this.store.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }

    this.store.set(key, now + this.ttlMs);
    return true;
  }

  reset(): void {
    this.store.clear();
  }
}

export class NotificationDeduplicator {
  private readonly ttlSeconds: number;
  private readonly memory: InMemoryDeduplicator;

  constructor(ttlSeconds: number = DEFAULT_TTL_SECONDS) {
    this.ttlSeconds = ttlSeconds;
    this.memory = new InMemoryDeduplicator(ttlSeconds * 1000);
  }

  /**
   * Atomically claims a notification event key.
   *
   * @returns `true` if this caller is the first to claim the event (send the
   *          notification), `false` if the event was already claimed within
   *          the dedup window (skip — it is a duplicate).
   */
  async claim(key: string): Promise<boolean> {
    const redisKey = `${DEDUP_KEY_PREFIX}${key}`;

    if (redisClient.isOpen) {
      try {
        const result = await redisClient.set(redisKey, "1", {
          NX: true,
          PX: this.ttlSeconds * 1000,
        });
        return result !== null;
      } catch (err) {
        console.warn(
          "NotificationDeduplicator: Redis claim failed, using in-process dedup:",
          err,
        );
      }
    }

    return this.memory.tryAcquire(key);
  }

  /** Clears the in-process store — primarily for tests. */
  reset(): void {
    this.memory.reset();
  }
}

export const notificationDeduplicator = new NotificationDeduplicator();
