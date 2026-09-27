/**
 * WebSocket Transaction Compression
 *
 * Provides delta compression for transaction updates sent over WebSocket:
 *   - Sends only changed fields instead of the full transaction object
 *   - Supports field subscriptions so clients receive only relevant fields
 *   - Optional gzip compression for large payloads
 *   - Bandwidth usage metrics
 */

import { gzipSync, gunzipSync } from "zlib";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransactionSnapshot {
  [key: string]: unknown;
}

export interface TransactionDelta {
  id: string;
  changedFields: Record<string, unknown>;
  removedFields: string[];
  compressedPayload?: string;
  timestamp: string;
}

export interface FieldSubscription {
  fields: Set<string>;
}

export interface CompressionOptions {
  /** Enable gzip compression for payloads larger than this threshold (bytes). */
  gzipThresholdBytes?: number;
  /** Fields that should always be included regardless of subscription. */
  alwaysInclude?: string[];
}

// ─── Bandwidth Metrics ────────────────────────────────────────────────────────

export interface BandwidthMetrics {
  fullPayloadsSent: number;
  deltaPayloadsSent: number;
  bytesSaved: number;
  gzipCompressions: number;
  totalBytesSent: number;
}

const metrics: BandwidthMetrics = {
  fullPayloadsSent: 0,
  deltaPayloadsSent: 0,
  bytesSaved: 0,
  gzipCompressions: 0,
  totalBytesSent: 0,
};

export function getBandwidthMetrics(): Readonly<BandwidthMetrics> {
  return { ...metrics };
}

export function resetBandwidthMetrics(): void {
  metrics.fullPayloadsSent = 0;
  metrics.deltaPayloadsSent = 0;
  metrics.bytesSaved = 0;
  metrics.gzipCompressions = 0;
  metrics.totalBytesSent = 0;
}

// ─── Delta Calculation ────────────────────────────────────────────────────────

/**
 * Compute the delta between a previous snapshot and the current state.
 * Returns null if there are no changes.
 */
export function computeDelta(
  previous: TransactionSnapshot | null,
  current: TransactionSnapshot,
): TransactionDelta | null {
  if (!previous) {
    // First update: send everything as changed
    return {
      id: String(current.id ?? ""),
      changedFields: { ...current },
      removedFields: [],
      timestamp: new Date().toISOString(),
    };
  }

  const changedFields: Record<string, unknown> = {};
  const removedFields: string[] = [];

  // Detect changed or new fields
  for (const [key, value] of Object.entries(current)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(value)) {
      changedFields[key] = value;
    }
  }

  // Detect removed fields
  for (const key of Object.keys(previous)) {
    if (!(key in current)) {
      removedFields.push(key);
    }
  }

  if (Object.keys(changedFields).length === 0 && removedFields.length === 0) {
    return null;
  }

  return {
    id: String(current.id ?? ""),
    changedFields,
    removedFields,
    timestamp: new Date().toISOString(),
  };
}

// ─── Field Filtering ──────────────────────────────────────────────────────────

/**
 * Filter a delta to include only fields the client is subscribed to.
 */
export function filterDeltaForSubscription(
  delta: TransactionDelta,
  subscription: FieldSubscription | null,
  alwaysInclude: string[] = [],
): TransactionDelta {
  if (!subscription) return delta;

  const alwaysSet = new Set(alwaysInclude);
  const filteredChanged: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(delta.changedFields)) {
    if (alwaysSet.has(key) || subscription.fields.has(key)) {
      filteredChanged[key] = value;
    }
  }

  const filteredRemoved = delta.removedFields.filter(
    (f) => alwaysSet.has(f) || subscription.fields.has(f),
  );

  return {
    ...delta,
    changedFields: filteredChanged,
    removedFields: filteredRemoved,
  };
}

// ─── Gzip Compression ─────────────────────────────────────────────────────────

/**
 * Optionally gzip-compress a delta if its serialized size exceeds the threshold.
 */
export function maybeGzipDelta(
  delta: TransactionDelta,
  thresholdBytes: number = 1024,
): TransactionDelta {
  const serialized = JSON.stringify(delta);

  if (Buffer.byteLength(serialized, "utf8") <= thresholdBytes) {
    return delta;
  }

  const compressed = gzipSync(Buffer.from(serialized, "utf8")).toString("base64");
  metrics.gzipCompressions++;

  return {
    ...delta,
    compressedPayload: compressed,
    changedFields: {},
    removedFields: [],
  };
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export interface ProcessedUpdate {
  payload: TransactionDelta;
  fullSizeBytes: number;
  compressedSizeBytes: number;
  bytesSaved: number;
}

/**
 * Full pipeline: compute delta → filter by subscription → gzip → metrics.
 */
export function processTransactionUpdate(
  previous: TransactionSnapshot | null,
  current: TransactionSnapshot,
  subscription: FieldSubscription | null = null,
  options: CompressionOptions = {},
): ProcessedUpdate | null {
  const delta = computeDelta(previous, current);
  if (!delta) return null;

  const fullSize = Buffer.byteLength(JSON.stringify(current), "utf8");

  const filtered = filterDeltaForSubscription(
    delta,
    subscription,
    options.alwaysInclude,
  );

  const compressed = maybeGzipDelta(
    filtered,
    options.gzipThresholdBytes ?? 1024,
  );

  const payloadSize = Buffer.byteLength(JSON.stringify(compressed), "utf8");
  const saved = fullSize - payloadSize;

  // Update metrics
  if (previous === null) {
    metrics.fullPayloadsSent++;
  } else {
    metrics.deltaPayloadsSent++;
  }
  metrics.bytesSaved += Math.max(0, saved);
  metrics.totalBytesSent += payloadSize;

  return {
    payload: compressed,
    fullSizeBytes: fullSize,
    compressedSizeBytes: payloadSize,
    bytesSaved: Math.max(0, saved),
  };
}
