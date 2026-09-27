/**
 * @file src/utils/compressionMetrics.ts
 *
 * Prometheus metrics for the compression middleware (both response compression
 * and request body decompression).
 *
 * Metrics exported:
 *  - compression_bytes_in_total        — uncompressed bytes before compression
 *  - compression_bytes_out_total       — compressed bytes after compression
 *  - compression_requests_total        — number of requests compressed per algorithm
 *  - compression_ratio                 — histogram of compression ratios
 *  - decompression_bytes_in_total      — compressed request body bytes received
 *  - decompression_bytes_out_total     — decompressed request body bytes
 *  - decompression_requests_total      — number of request bodies decompressed
 *  - decompression_errors_total        — number of decompression failures
 */

import { Histogram, Counter, register } from "prom-client";

// ---------------------------------------------------------------------------
// Response compression metrics
// ---------------------------------------------------------------------------

/**
 * Original (uncompressed) response body size in bytes, observed before
 * compression is applied.
 */
export const compressionBytesIn = new Histogram({
  name: "compression_bytes_in",
  help: "Uncompressed response body size in bytes before compression",
  labelNames: ["algorithm", "route"] as const,
  buckets: [512, 1024, 4096, 16384, 65536, 262144, 1048576],
  registers: [register],
});

/**
 * Compressed response body size in bytes after compression.
 */
export const compressionBytesOut = new Histogram({
  name: "compression_bytes_out",
  help: "Compressed response body size in bytes after compression",
  labelNames: ["algorithm", "route"] as const,
  buckets: [256, 512, 2048, 8192, 32768, 131072, 524288],
  registers: [register],
});

/**
 * Total number of responses compressed, labelled by algorithm and route.
 */
export const compressionRequestsTotal = new Counter({
  name: "compression_requests_total",
  help: "Total number of responses compressed by algorithm",
  labelNames: ["algorithm", "route"] as const,
  registers: [register],
});

/**
 * Distribution of compression ratios (compressed / original).
 * A ratio of 0.5 means the compressed body is half the original size.
 */
export const compressionRatioHistogram = new Histogram({
  name: "compression_ratio",
  help: "Compression ratio (compressed size / original size); lower is better",
  labelNames: ["algorithm", "route"] as const,
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Request body decompression metrics (Issue #420)
// ---------------------------------------------------------------------------

/**
 * Compressed request body bytes received from clients.
 */
export const decompressionBytesIn = new Counter({
  name: "decompression_bytes_in_total",
  help: "Total compressed request body bytes received from clients",
  labelNames: ["algorithm", "route"] as const,
  registers: [register],
});

/**
 * Decompressed request body bytes handed to route handlers.
 */
export const decompressionBytesOut = new Counter({
  name: "decompression_bytes_out_total",
  help: "Total decompressed request body bytes passed to route handlers",
  labelNames: ["algorithm", "route"] as const,
  registers: [register],
});

/**
 * Total number of request bodies decompressed.
 */
export const decompressionRequestsTotal = new Counter({
  name: "decompression_requests_total",
  help: "Total number of compressed request bodies decompressed",
  labelNames: ["algorithm", "route"] as const,
  registers: [register],
});

/**
 * Total number of request body decompression failures.
 */
export const decompressionErrorsTotal = new Counter({
  name: "decompression_errors_total",
  help: "Total number of request body decompression failures",
  labelNames: ["algorithm", "route"] as const,
  registers: [register],
});
