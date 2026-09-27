/**
 * @file src/middleware/brotliCompression.ts
 *
 * Brotli compression middleware with automatic gzip fallback.
 *
 * Behaviour:
 *  - Brotli (br) is used when the client sends `Accept-Encoding: br`
 *    and the response body exceeds the configured size threshold (default 1 KB).
 *  - Gzip is used as an automatic fallback when the client advertises `gzip`
 *    but not `br`, or when Brotli is disabled via configuration.
 *  - Compression is skipped entirely for:
 *      • Server-Sent Events (`text/event-stream`)
 *      • WebSocket upgrades
 *      • Already-compressed content types (image/*, video/*, audio/*, zip, gzip …)
 *      • Responses below the threshold
 *      • Requests that carry the `X-No-Compression: 1` header
 *      • Routes decorated with `res.locals.noCompression = true`
 *  - Per-route opt-in/opt-out is available via `res.locals.compression`:
 *      `res.locals.compression = 'br' | 'gzip' | 'none'`
 *  - Prometheus metrics track bytes saved and requests compressed per algorithm.
 */

import zlib from "zlib";
import { Request, Response, NextFunction } from "express";
import {
  compressionBytesIn,
  compressionBytesOut,
  compressionRequestsTotal,
  compressionRatioHistogram,
} from "../utils/compressionMetrics";

// ---------------------------------------------------------------------------
// Type augmentation — add compression locals to Express Response
// ---------------------------------------------------------------------------
declare global {
  namespace Express {
    interface Locals {
      /** Set to 'br' | 'gzip' | 'none' to override auto-detection per route. */
      compression?: "br" | "gzip" | "none";
      /** Convenience alias — set to true to skip compression on this route. */
      noCompression?: boolean;
    }
  }
}

// ---------------------------------------------------------------------------
// Content types that should NEVER be compressed (already dense / streaming)
// ---------------------------------------------------------------------------
const SKIP_CONTENT_TYPE_PATTERNS = [
  /^image\//,
  /^video\//,
  /^audio\//,
  /^application\/zip/,
  /^application\/gzip/,
  /^application\/x-bzip/,
  /^application\/x-rar/,
  /^application\/x-7z/,
  /^application\/x-tar/,
  /^font\/(woff2?|otf|ttf)/,
  // SSE — must NOT be compressed (chunked streaming)
  /^text\/event-stream/,
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface BrotliCompressionOptions {
  /** Minimum body size in bytes before compression is applied. Default: 1024 */
  threshold?: number;
  /** Brotli quality level 0-11. Default: 4 (fast + good ratio for APIs). */
  brotliQuality?: number;
  /** Gzip level 0-9. Default: 6. */
  gzipLevel?: number;
  /** Set false to disable Brotli entirely (gzip-only mode). Default: true. */
  brotliEnabled?: boolean;
}

const DEFAULT_OPTIONS: Required<BrotliCompressionOptions> = {
  threshold: 1024,
  brotliQuality: 4,
  gzipLevel: 6,
  brotliEnabled: true,
};

// ---------------------------------------------------------------------------
// Accept-Encoding negotiation helpers
// ---------------------------------------------------------------------------

/** Parse quality value from a single Accept-Encoding token like "br;q=0.9" */
function parseQuality(token: string): number {
  const match = token.match(/;q=([\d.]+)/);
  if (!match) return 1.0;
  const q = parseFloat(match[1]);
  return isNaN(q) ? 1.0 : q;
}

interface AcceptedEncodings {
  br: number;   // quality or 0 if not present
  gzip: number;
  deflate: number;
}

function parseAcceptEncoding(header: string | undefined): AcceptedEncodings {
  const result: AcceptedEncodings = { br: 0, gzip: 0, deflate: 0 };
  if (!header) return result;

  for (const token of header.split(",")) {
    const enc = token.trim().toLowerCase();
    if (enc.startsWith("br")) {
      result.br = parseQuality(enc);
    } else if (enc.startsWith("gzip")) {
      result.gzip = parseQuality(enc);
    } else if (enc.startsWith("deflate")) {
      result.deflate = parseQuality(enc);
    } else if (enc === "*" || enc.startsWith("*")) {
      // wildcard — treat all as acceptable at stated quality
      const q = parseQuality(enc);
      result.br = result.br || q;
      result.gzip = result.gzip || q;
      result.deflate = result.deflate || q;
    }
  }
  return result;
}

/** Decide which encoding to use, returning null for "no compression". */
function selectEncoding(
  req: Request,
  res: Response,
  opts: Required<BrotliCompressionOptions>,
): "br" | "gzip" | null {
  // 1. Explicit per-route override wins
  const override = res.locals.noCompression
    ? "none"
    : res.locals.compression;

  if (override === "none") return null;
  if (override === "br" && opts.brotliEnabled) return "br";
  if (override === "gzip") return "gzip";

  // 2. Skip if client explicitly asked for no compression
  if (req.headers["x-no-compression"]) return null;

  // 3. SSE / streaming — never compress
  const upgrade = req.headers["upgrade"];
  if (upgrade && upgrade.toLowerCase() === "websocket") return null;

  // 4. Parse Accept-Encoding
  const accepted = parseAcceptEncoding(req.headers["accept-encoding"] as string | undefined);

  if (opts.brotliEnabled && accepted.br > 0) return "br";
  if (accepted.gzip > 0) return "gzip";
  return null;
}

function shouldSkipContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return SKIP_CONTENT_TYPE_PATTERNS.some((re) => re.test(contentType));
}

// ---------------------------------------------------------------------------
// Main middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware that applies Brotli or gzip compression to
 * JSON / text responses, with full metrics instrumentation.
 */
export function brotliCompression(
  options: BrotliCompressionOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const opts: Required<BrotliCompressionOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
    // Honour env-var overrides
    threshold: options.threshold ??
      parseInt(process.env.COMPRESSION_THRESHOLD || "", 10) ||
      DEFAULT_OPTIONS.threshold,
    brotliQuality: options.brotliQuality ??
      parseInt(process.env.BROTLI_QUALITY || "", 10) ||
      DEFAULT_OPTIONS.brotliQuality,
    gzipLevel: options.gzipLevel ??
      parseInt(process.env.COMPRESSION_LEVEL || "", 10) ||
      DEFAULT_OPTIONS.gzipLevel,
    brotliEnabled: options.brotliEnabled ??
      process.env.BROTLI_ENABLED !== "false",
  };

  return function compressionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const encoding = selectEncoding(req, res, opts);
    if (!encoding) {
      return next();
    }

    // Intercept res.write / res.end to capture body before sending
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    const chunks: Buffer[] = [];
    let compressionDone = false;

    /**
     * Compress accumulated body chunks and flush to the real socket.
     */
    function flush(finalChunk?: Buffer | string | null): void {
      if (compressionDone) return;
      compressionDone = true;

      if (finalChunk) {
        chunks.push(
          Buffer.isBuffer(finalChunk)
            ? finalChunk
            : Buffer.from(finalChunk as string),
        );
      }

      // Re-check content-type now that headers are available
      const contentType = res.getHeader("content-type") as string | undefined;
      if (shouldSkipContentType(contentType)) {
        // Restore and send uncompressed
        res.write = originalWrite;
        res.end = originalEnd;
        const body = Buffer.concat(chunks);
        if (body.length > 0) originalWrite(body);
        originalEnd();
        return;
      }

      const body = Buffer.concat(chunks);

      // Below threshold — send uncompressed
      if (body.length < opts.threshold) {
        res.write = originalWrite;
        res.end = originalEnd;
        if (body.length > 0) originalWrite(body);
        originalEnd();
        return;
      }

      // Record original size
      compressionBytesIn.observe(
        { algorithm: encoding, route: req.route?.path ?? req.path },
        body.length,
      );

      // Compress
      const compressFn =
        encoding === "br"
          ? (buf: Buffer, cb: (err: Error | null, result: Buffer) => void) =>
              zlib.brotliCompress(
                buf,
                {
                  params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: opts.brotliQuality,
                  },
                },
                cb,
              )
          : (buf: Buffer, cb: (err: Error | null, result: Buffer) => void) =>
              zlib.gzip(buf, { level: opts.gzipLevel }, cb);

      compressFn(body, (err, compressed) => {
        res.write = originalWrite;
        res.end = originalEnd;

        if (err) {
          // On error fall back to sending uncompressed
          console.error("[brotliCompression] Compression error:", err.message);
          compressionRequestsTotal.inc({ algorithm: "none", route: req.route?.path ?? req.path });
          if (body.length > 0) originalWrite(body);
          originalEnd();
          return;
        }

        const route = req.route?.path ?? req.path;

        res.setHeader("Content-Encoding", encoding);
        res.setHeader("Content-Length", compressed.length);
        res.removeHeader("ETag"); // ETag would be stale after compression

        // Vary header so proxies cache per encoding
        const vary = res.getHeader("Vary") as string | undefined;
        if (!vary) {
          res.setHeader("Vary", "Accept-Encoding");
        } else if (!vary.includes("Accept-Encoding")) {
          res.setHeader("Vary", `${vary}, Accept-Encoding`);
        }

        // Emit metrics
        compressionBytesOut.observe({ algorithm: encoding, route }, compressed.length);
        compressionRequestsTotal.inc({ algorithm: encoding, route });

        const ratio = body.length > 0 ? compressed.length / body.length : 1;
        compressionRatioHistogram.observe({ algorithm: encoding, route }, ratio);

        originalWrite(compressed);
        originalEnd();
      });
    }

    // Override write to buffer chunks
    (res as any).write = function (
      chunk: Buffer | string,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      // Always report success so callers don't stall
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (callback) callback();
      return true;
    };

    // Override end to compress and send
    (res as any).end = function (
      chunk?: Buffer | string | null,
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): Response {
      flush(chunk ?? null);
      return res;
    };

    next();
  };
}

/**
 * Convenience middleware for per-route opt-out of compression
 * (e.g. SSE routes, binary download routes).
 *
 * Usage:
 *   router.get('/stream', noCompressionMiddleware, handler)
 */
export function noCompressionMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.locals.noCompression = true;
  next();
}

/**
 * Force a specific encoding for a single route.
 *
 * Usage:
 *   router.get('/heavy-json', forceEncoding('br'), handler)
 */
export function forceEncoding(enc: "br" | "gzip" | "none") {
  return function (_req: Request, res: Response, next: NextFunction): void {
    res.locals.compression = enc;
    next();
  };
}
