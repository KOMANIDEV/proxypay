import { createHash } from "crypto";
import { createGunzip, createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable, Writable } from "stream";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransactionDelta {
  id: string;
  changedFields: Record<string, unknown>;
  removedFields: string[];
  sequenceNumber: number;
  timestamp: number;
}

/**
 * Result of validating that a delta, when applied to its base snapshot,
 * reconstructs the target snapshot exactly.
 */
export interface DeltaValidationResult {
  /** True when the reconstructed snapshot deep-equals the target snapshot. */
  valid: boolean;
  /** Snapshot produced by applying the delta to the base snapshot. */
  reconstructed: TransactionSnapshot | null;
  /** Human-readable descriptions of every mismatch that was found. */
  errors: string[];
}

export interface CompressedPayload {
  compressed: boolean;
  algorithm: "gzip" | "none";
  checksum: string;
  originalSize: number;
  compressedSize: number;
  data: string | Buffer;
}

export interface BandwidthMetrics {
  totalPayloadsSent: number;
  totalBytesUncompressed: number;
  totalBytesCompressed: number;
  averageCompressionRatio: number;
  lastUpdated: number;
}

export interface FieldSubscription {
  clientId: string;
  fields: Set<string>;
}

export interface TransactionSnapshot {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GZIP_THRESHOLD_BYTES = 1024;
const MAX_CACHE_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// TransactionCompressionService
// ---------------------------------------------------------------------------

export class TransactionCompressionService {
  private snapshots: Map<string, TransactionSnapshot> = new Map();
  private sequenceCounters: Map<string, number> = new Map();
  private deltaValidationFailures = 0;
  private bandwidthMetrics: BandwidthMetrics = {
    totalPayloadsSent: 0,
    totalBytesUncompressed: 0,
    totalBytesCompressed: 0,
    averageCompressionRatio: 0,
    lastUpdated: Date.now(),
  };

  // -------------------------------------------------------------------------
  // Delta computation
  // -------------------------------------------------------------------------

  /**
   * Compute the delta between a previous snapshot and the current transaction
   * fields. Returns null if nothing changed.
   */
  computeDelta(
    transactionId: string,
    currentFields: TransactionSnapshot,
  ): TransactionDelta | null {
    const previous = this.snapshots.get(transactionId) ?? {};
    const changedFields: Record<string, unknown> = {};
    const removedFields: string[] = [];

    for (const [key, value] of Object.entries(currentFields)) {
      if (key === "id") continue;
      const prev = previous[key];
      if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(value)) {
        changedFields[key] = value;
      }
    }

    for (const key of Object.keys(previous)) {
      if (key === "id") continue;
      if (!(key in currentFields)) {
        removedFields.push(key);
      }
    }

    if (Object.keys(changedFields).length === 0 && removedFields.length === 0) {
      return null;
    }

    const seq = (this.sequenceCounters.get(transactionId) ?? 0) + 1;
    this.sequenceCounters.set(transactionId, seq);

    const delta: TransactionDelta = {
      id: transactionId,
      changedFields,
      removedFields,
      sequenceNumber: seq,
      timestamp: Date.now(),
    };

    this.snapshots.set(transactionId, { ...currentFields });
    this.evictIfNeeded();

    return delta;
  }

  /**
   * Get the last known snapshot for a transaction.
   */
  getSnapshot(transactionId: string): TransactionSnapshot | null {
    return this.snapshots.get(transactionId) ?? null;
  }

  /**
   * Manually set a snapshot (e.g. for initial broadcast).
   */
  setSnapshot(transactionId: string, fields: TransactionSnapshot): void {
    this.snapshots.set(transactionId, { ...fields });
    this.evictIfNeeded();
  }

  /**
   * Clear snapshot and sequence counter for a transaction.
   */
  clearSnapshot(transactionId: string): void {
    this.snapshots.delete(transactionId);
    this.sequenceCounters.delete(transactionId);
  }

  // -------------------------------------------------------------------------
  // Delta validation
  // -------------------------------------------------------------------------

  /**
   * Validate that applying `delta` to `base` reconstructs `target` exactly.
   *
   * A mismatch means the delta payload would corrupt client state, so
   * failures are logged (with the delta sequence number) and counted for
   * observability instead of being silently accepted.
   */
  validateDelta(
    transactionId: string,
    base: TransactionSnapshot,
    target: TransactionSnapshot,
    delta: TransactionDelta,
  ): DeltaValidationResult {
    const result = validateDelta(base, target, delta);

    if (!result.valid) {
      this.deltaValidationFailures += 1;
      logger.error(
        {
          transactionId,
          sequenceNumber: delta.sequenceNumber,
          errors: result.errors,
        },
        "Transaction delta validation failed",
      );
    }

    return result;
  }

  /**
   * Number of delta validations that failed since the last reset.
   */
  getDeltaValidationFailureCount(): number {
    return this.deltaValidationFailures;
  }

  // -------------------------------------------------------------------------
  // Field subscriptions
  // -------------------------------------------------------------------------

  /**
   * Filter an object to only include the fields the client is subscribed to.
   * If no subscription exists, returns the full payload.
   */
  filterBySubscription<T extends Record<string, unknown>>(
    payload: T,
    subscription?: FieldSubscription,
  ): Partial<T> {
    if (!subscription || subscription.fields.size === 0) {
      return payload;
    }

    const filtered: Partial<T> = {};
    for (const key of subscription.fields) {
      if (key in payload) {
        (filtered as any)[key] = payload[key];
      }
    }
    return filtered;
  }

  /**
   * Merge subscription fields from a delta with existing subscription
   * to produce a full update for the client.
   */
  mergeDeltaWithSubscription(
    delta: TransactionDelta,
    subscription?: FieldSubscription,
  ): Record<string, unknown> {
    if (!subscription || subscription.fields.size === 0) {
      return { ...delta.changedFields };
    }

    const merged: Record<string, unknown> = {};
    for (const field of subscription.fields) {
      if (field in delta.changedFields) {
        merged[field] = delta.changedFields[field];
      }
    }
    return merged;
  }

  // -------------------------------------------------------------------------
  // Gzip compression
  // -------------------------------------------------------------------------

  /**
   * Optionally gzip-compress a JSON string if it exceeds the threshold.
   * Returns a CompressedPayload with metadata.
   */
  async maybeCompress(payload: string): Promise<CompressedPayload> {
    const originalSize = Buffer.byteLength(payload, "utf-8");
    const checksum = createHash("sha256").update(payload).digest("hex").slice(0, 16);

    if (originalSize < GZIP_THRESHOLD_BYTES) {
      return {
        compressed: false,
        algorithm: "none",
        checksum,
        originalSize,
        compressedSize: originalSize,
        data: payload,
      };
    }

    const compressedBuffer = await gzipBuffer(Buffer.from(payload, "utf-8"));
    const compressedSize = compressedBuffer.length;

    if (compressedSize >= originalSize) {
      return {
        compressed: false,
        algorithm: "none",
        checksum,
        originalSize,
        compressedSize: originalSize,
        data: payload,
      };
    }

    this.updateBandwidthMetrics(originalSize, compressedSize);

    return {
      compressed: true,
      algorithm: "gzip",
      checksum,
      originalSize,
      compressedSize,
      data: compressedBuffer,
    };
  }

  /**
   * Decompress a gzip-compressed payload.
   */
  async decompress(payload: Buffer): Promise<string> {
    return gunzipBuffer(payload);
  }

  // -------------------------------------------------------------------------
  // Bandwidth metrics
  // -------------------------------------------------------------------------

  getBandwidthMetrics(): BandwidthMetrics {
    return { ...this.bandwidthMetrics };
  }

  resetBandwidthMetrics(): void {
    this.bandwidthMetrics = {
      totalPayloadsSent: 0,
      totalBytesUncompressed: 0,
      totalBytesCompressed: 0,
      averageCompressionRatio: 0,
      lastUpdated: Date.now(),
    };
  }

  private updateBandwidthMetrics(originalBytes: number, compressedBytes: number): void {
    const m = this.bandwidthMetrics;
    m.totalPayloadsSent++;
    m.totalBytesUncompressed += originalBytes;
    m.totalBytesCompressed += compressedBytes;
    m.averageCompressionRatio =
      m.totalBytesUncompressed > 0
        ? m.totalBytesCompressed / m.totalBytesUncompressed
        : 1;
    m.lastUpdated = Date.now();
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  private evictIfNeeded(): void {
    if (this.snapshots.size > MAX_CACHE_ENTRIES) {
      const keysToDelete = Array.from(this.snapshots.keys()).slice(
        0,
        this.snapshots.size - MAX_CACHE_ENTRIES,
      );
      for (const key of keysToDelete) {
        this.snapshots.delete(key);
        this.sequenceCounters.delete(key);
      }
    }
  }

  /**
   * Clear all cached data.
   */
  reset(): void {
    this.snapshots.clear();
    this.sequenceCounters.clear();
    this.deltaValidationFailures = 0;
    this.resetBandwidthMetrics();
  }
}

// ---------------------------------------------------------------------------
// Delta helpers
// ---------------------------------------------------------------------------

/**
 * Apply a delta to a base snapshot, producing the reconstructed snapshot.
 * Changed fields are upserted and removed fields are deleted.
 */
export function applyDelta(
  base: TransactionSnapshot,
  delta: TransactionDelta,
): TransactionSnapshot {
  const reconstructed: TransactionSnapshot = { ...base };

  for (const [key, value] of Object.entries(delta.changedFields)) {
    reconstructed[key] = value;
  }

  for (const field of delta.removedFields) {
    delete reconstructed[field];
  }

  return reconstructed;
}

/**
 * Verify that `base + delta === target`.
 *
 * Field-by-field comparison is used (rather than a JSON.stringify equality
 * check) so that a mismatch reports every offending field instead of only the
 * first one, which makes production debugging possible.
 */
export function validateDelta(
  base: TransactionSnapshot,
  target: TransactionSnapshot,
  delta: TransactionDelta,
): DeltaValidationResult {
  const reconstructed = applyDelta(base, delta);
  const errors: string[] = [];

  for (const [key, value] of Object.entries(target)) {
    if (key === "id") continue;

    if (!(key in reconstructed)) {
      errors.push(`field missing after applying delta: ${key}`);
      continue;
    }

    if (JSON.stringify(reconstructed[key]) !== JSON.stringify(value)) {
      errors.push(`field mismatch after applying delta: ${key}`);
    }
  }

  for (const key of Object.keys(reconstructed)) {
    if (key === "id") continue;

    if (!(key in target)) {
      errors.push(`unexpected field after applying delta: ${key}`);
    }
  }

  for (const field of delta.removedFields) {
    if (field in reconstructed) {
      errors.push(`field marked removed is still present: ${field}`);
    }
  }

  return {
    valid: errors.length === 0,
    reconstructed,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Gzip helpers
// ---------------------------------------------------------------------------

async function gzipBuffer(input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const gzip = createGzip({ level: 6 });
  const writable = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(chunk);
      cb();
    },
  });

  const readable = new Readable({
    read() {
      this.push(input);
      this.push(null);
    },
  });

  await pipeline(readable, gzip, writable);
  return Buffer.concat(chunks);
}

async function gunzipBuffer(input: Buffer): Promise<string> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  const writable = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(chunk);
      cb();
    },
  });

  const readable = new Readable({
    read() {
      this.push(input);
      this.push(null);
    },
  });

  await pipeline(readable, gunzip, writable);
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const transactionCompressionService = new TransactionCompressionService();
