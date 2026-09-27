/**
 * @file src/middleware/requestDecompression.ts
 *
 * Request body decompression middleware (Issue #420).
 *
 * Decompresses gzip, deflate, and Brotli encoded request bodies.
 * The decompressed content is parsed and placed on `req.body` (JSON) or
 * exposed as a Buffer on `req.rawBody`.
 *
 * Must be applied BEFORE any body-parsing middleware when compressed request
 * bodies are expected.
 *
 * Usage:
 *   app.use(requestDecompression());   // before express.json()
 *
 * Per-route opt-out:
 *   router.post("/raw-upload", noDecompressionMiddleware, handler);
 */

import * as zlib from "zlib";
import { Request, Response, NextFunction } from "express";
import {
  decompressionBytesIn,
  decompressionBytesOut,
  decompressionRequestsTotal,
  decompressionErrorsTotal,
} from "../utils/compressionMetrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestDecompressionOptions {
  /** Maximum decompressed body size in bytes. Default: 50 MB. */
  maxBodySize?: number;
  /** Supported Content-Encoding values. Default: ["gzip","deflate","br"]. */
  supportedEncodings?: string[];
}

type SupportedEncoding = "gzip" | "deflate" | "br";

const DEFAULT_MAX_BODY = 50 * 1024 * 1024;
const DEFAULT_SUPPORTED: string[] = ["gzip", "deflate", "br"];

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

function decompress(data: Buffer, encoding: SupportedEncoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip") {
      zlib.gunzip(data, (err, r) => (err ? reject(err) : resolve(r)));
    } else if (encoding === "deflate") {
      zlib.inflate(data, (err, r) => {
        if (!err) return resolve(r);
        zlib.inflateRaw(data, (err2, r2) => (err2 ? reject(err2) : resolve(r2)));
      });
    } else if (encoding === "br") {
      zlib.brotliDecompress(data, (err, r) => (err ? reject(err) : resolve(r)));
    } else {
      reject(new Error(`Unsupported encoding: ${encoding}`));
    }
  });
}

function collectBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Decompresses the request body if `Content-Encoding` is present.
 * Sets `req.body` to the parsed JSON (or plain string/Buffer) and marks the
 * request as already body-parsed so downstream `express.json()` skips it.
 */
export function requestDecompression(
  options: RequestDecompressionOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const maxBodySize =
    options.maxBodySize ??
    (parseInt(process.env.MAX_REQUEST_BODY_SIZE || "0", 10) || DEFAULT_MAX_BODY);
  const supportedEncodings =
    options.supportedEncodings ?? DEFAULT_SUPPORTED;

  return function decompressionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const contentEncoding = (
      (req.headers["content-encoding"] as string) ?? ""
    )
      .toLowerCase()
      .trim();

    if (!contentEncoding || contentEncoding === "identity") {
      return next();
    }

    const route = req.path;

    if (!supportedEncodings.includes(contentEncoding)) {
      decompressionErrorsTotal.inc({ algorithm: contentEncoding, route });
      res.status(415).json({
        error: "Unsupported Media Type",
        message: `Content-Encoding "${contentEncoding}" is not supported. Supported: ${supportedEncodings.join(", ")}`,
        code: "UNSUPPORTED_ENCODING",
      });
      return;
    }

    collectBody(req)
      .then(async (compressed) => {
        if (compressed.length === 0) {
          return next();
        }

        decompressionBytesIn.inc({ algorithm: contentEncoding, route }, compressed.length);

        let plain: Buffer;
        try {
          plain = await decompress(compressed, contentEncoding as SupportedEncoding);
        } catch (err) {
          decompressionErrorsTotal.inc({ algorithm: contentEncoding, route });
          res.status(400).json({
            error: "Bad Request",
            message: `Failed to decompress request body: ${err instanceof Error ? err.message : String(err)}`,
            code: "DECOMPRESSION_FAILED",
          });
          return;
        }

        if (plain.length > maxBodySize) {
          decompressionErrorsTotal.inc({ algorithm: contentEncoding, route });
          res.status(413).json({
            error: "Payload Too Large",
            message: `Decompressed body (${plain.length} bytes) exceeds max allowed size (${maxBodySize} bytes)`,
            code: "PAYLOAD_TOO_LARGE",
          });
          return;
        }

        decompressionBytesOut.inc({ algorithm: contentEncoding, route }, plain.length);
        decompressionRequestsTotal.inc({ algorithm: contentEncoding, route });

        // Remove encoding header so downstream parsers don't try to decompress again
        delete req.headers["content-encoding"];
        req.headers["content-length"] = String(plain.length);

        // Parse the decompressed body and attach to req.body
        const contentType = (req.headers["content-type"] as string) ?? "";
        if (contentType.includes("application/json")) {
          try {
            req.body = JSON.parse(plain.toString("utf8"));
          } catch {
            req.body = plain.toString("utf8");
          }
        } else if (contentType.startsWith("text/")) {
          req.body = plain.toString("utf8");
        } else {
          // Binary / unknown: expose as Buffer
          (req as any).rawBody = plain;
          req.body = plain;
        }

        // Mark body as already parsed so express.json() / express.text() skip it
        (req as any)._body = true;

        next();
      })
      .catch((err) => {
        decompressionErrorsTotal.inc({ algorithm: contentEncoding, route });
        next(err);
      });
  };
}

// ---------------------------------------------------------------------------
// Per-route opt-out
// ---------------------------------------------------------------------------

/**
 * Skip decompression for a specific route.
 * Removes the Content-Encoding header so downstream parsers treat body as-is.
 */
export function noDecompressionMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  delete req.headers["content-encoding"];
  next();
}
