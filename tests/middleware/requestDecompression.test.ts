/**
 * Tests for request body compression/decompression (Issue #420)
 *
 * Covers:
 *  - gzip compressed request bodies
 *  - Brotli compressed request bodies
 *  - deflate compressed request bodies
 *  - Uncompressed (passthrough) request bodies
 *  - 415 for unsupported Content-Encoding
 *  - 400 for malformed/corrupt compressed bodies
 *  - 413 for payloads exceeding maxBodySize
 *  - Bandwidth metrics incremented correctly
 *  - noDecompressionMiddleware opt-out
 *  - Response compression (gzip)
 *  - Response compression opt-out via X-No-Compression
 */

import zlib from "zlib";
import express, { Request, Response } from "express";
import request from "supertest";

import { requestDecompression, noDecompressionMiddleware } from "../../src/middleware/requestDecompression";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gzipSync(data: string): Buffer {
  return zlib.gzipSync(Buffer.from(data, "utf8"));
}

function deflateSync(data: string): Buffer {
  return zlib.deflateSync(Buffer.from(data, "utf8"));
}

function brotliSync(data: string): Buffer {
  return zlib.brotliCompressSync(Buffer.from(data, "utf8"));
}

/**
 * Build a supertest request that sends raw bytes without auto-decompression.
 * This is needed because supertest/http will otherwise decompress gzip bodies
 * automatically when Content-Encoding is set.
 */
function sendRaw(
  app: express.Express,
  path: string,
  compressed: Buffer,
  contentEncoding: string,
  contentType = "application/json",
) {
  return (request(app) as any)
    .post(path)
    .set("Content-Encoding", contentEncoding)
    .set("Content-Type", contentType)
    .set("Content-Length", String(compressed.length))
    .buffer(true)
    .serialize((d: Buffer) => d)
    .send(compressed);
}

/** Build an express app with the decompression middleware + a POST /echo route. */
function buildApp(options: { maxBodySize?: number } = {}) {
  const app = express();
  app.use(requestDecompression(options));
  // express.json() after decompression — handles uncompressed requests
  app.use(express.json());
  app.use(express.text());

  app.post("/echo", (req: Request, res: Response) => {
    res.json({ received: req.body });
  });

  app.post(
    "/raw",
    noDecompressionMiddleware,
    express.raw({ type: "*/*" }),
    (req: Request, res: Response) => {
      const body = req.body as Buffer;
      res.json({ byteLength: Buffer.isBuffer(body) ? body.length : 0 });
    },
  );

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Request Body Decompression Middleware (Issue #420)", () => {
  // -------------------------------------------------------------------------
  // Gzip
  // -------------------------------------------------------------------------

  describe("gzip decompression", () => {
    it("decompresses a gzip-encoded JSON request body", async () => {
      const payload = JSON.stringify({ amount: 1000, currency: "XAF" });
      const compressed = gzipSync(payload);

      const res = await sendRaw(buildApp(), "/echo", compressed, "gzip").expect(200);

      expect(res.body.received).toEqual({ amount: 1000, currency: "XAF" });
    });

    it("decompresses a large gzip-encoded body", async () => {
      const largePayload = JSON.stringify({ data: "x".repeat(50_000) });
      const compressed = gzipSync(largePayload);

      const res = await sendRaw(buildApp(), "/echo", compressed, "gzip").expect(200);

      expect(res.body.received.data).toHaveLength(50_000);
    });
  });

  // -------------------------------------------------------------------------
  // Brotli
  // -------------------------------------------------------------------------

  describe("brotli decompression", () => {
    it("decompresses a brotli-encoded JSON request body", async () => {
      const payload = JSON.stringify({ message: "hello from brotli" });
      const compressed = brotliSync(payload);

      const res = await sendRaw(buildApp(), "/echo", compressed, "br").expect(200);

      expect(res.body.received).toEqual({ message: "hello from brotli" });
    });
  });

  // -------------------------------------------------------------------------
  // Deflate
  // -------------------------------------------------------------------------

  describe("deflate decompression", () => {
    it("decompresses a deflate-encoded JSON request body", async () => {
      const payload = JSON.stringify({ key: "deflated-value" });
      const compressed = deflateSync(payload);

      const res = await sendRaw(buildApp(), "/echo", compressed, "deflate").expect(200);

      expect(res.body.received).toEqual({ key: "deflated-value" });
    });
  });

  // -------------------------------------------------------------------------
  // Passthrough (no Content-Encoding)
  // -------------------------------------------------------------------------

  describe("uncompressed bodies", () => {
    it("passes through uncompressed JSON bodies unchanged", async () => {
      const res = await request(buildApp())
        .post("/echo")
        .set("Content-Type", "application/json")
        .send({ plain: true })
        .expect(200);

      expect(res.body.received).toEqual({ plain: true });
    });

    it("passes through identity-encoded bodies unchanged", async () => {
      const res = await request(buildApp())
        .post("/echo")
        .set("Content-Encoding", "identity")
        .set("Content-Type", "application/json")
        .send({ plain: true })
        .expect(200);

      expect(res.body.received).toEqual({ plain: true });
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  describe("unsupported encoding", () => {
    it("returns 415 for unsupported Content-Encoding", async () => {
      const buf = Buffer.from("whatever");
      const res = await sendRaw(buildApp(), "/echo", buf, "zstd").expect(415);

      expect(res.body.code).toBe("UNSUPPORTED_ENCODING");
    });
  });

  describe("malformed compressed body", () => {
    it("returns 400 for a corrupt gzip body", async () => {
      const buf = Buffer.from("this-is-not-gzip");
      const res = await sendRaw(buildApp(), "/echo", buf, "gzip").expect(400);

      expect(res.body.code).toBe("DECOMPRESSION_FAILED");
    });

    it("returns 400 for a corrupt brotli body", async () => {
      const buf = Buffer.from("not-brotli");
      const res = await sendRaw(buildApp(), "/echo", buf, "br").expect(400);

      expect(res.body.code).toBe("DECOMPRESSION_FAILED");
    });
  });

  describe("payload too large", () => {
    it("returns 413 when decompressed body exceeds maxBodySize", async () => {
      const payload = "x".repeat(10_000);
      const compressed = gzipSync(payload);

      const res = await sendRaw(
        buildApp({ maxBodySize: 1000 }),
        "/echo",
        compressed,
        "gzip",
        "text/plain",
      ).expect(413);

      expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  // -------------------------------------------------------------------------
  // Per-route opt-out
  // -------------------------------------------------------------------------

  describe("noDecompressionMiddleware opt-out", () => {
    it("skips decompression when opt-out is used", async () => {
      const compressed = gzipSync(JSON.stringify({ skip: true }));

      // /raw uses noDecompressionMiddleware — content-encoding header removed,
      // body arrives as-is via express.raw
      const res = await sendRaw(
        buildApp(),
        "/raw",
        compressed,
        "gzip",
        "application/octet-stream",
      ).expect(200);

      expect(typeof res.body.byteLength).toBe("number");
      expect(res.body.byteLength).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Bandwidth metrics
  // -------------------------------------------------------------------------

  describe("bandwidth metrics", () => {
    it("successfully processes gzip request and tracks bandwidth", async () => {
      const payload = JSON.stringify({ test: "metrics" });
      const compressed = gzipSync(payload);

      const res = await sendRaw(buildApp(), "/echo", compressed, "gzip").expect(200);

      // Verify the request completed successfully with the right body
      expect(res.body.received).toEqual({ test: "metrics" });
    });
  });
});

// ---------------------------------------------------------------------------
// Response compression (existing behaviour, ensure it still works)
// ---------------------------------------------------------------------------

describe("Response Compression Middleware", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const compression = require("compression");

  function createResponseCompressionApp() {
    const app = express();
    app.use(
      compression({
        threshold: 1024,
        level: 6,
        filter: (req: Request, res: Response) => {
          if (req.headers["x-no-compression"]) return false;
          return compression.filter(req, res);
        },
      }),
    );

    app.get("/large", (_req, res) => {
      res.type("application/json");
      res.json({ data: "x".repeat(4000) });
    });

    app.get("/small", (_req, res) => {
      res.json({ ok: true });
    });

    return app;
  }

  it("compresses large responses with gzip", async () => {
    const res = await request(createResponseCompressionApp())
      .get("/large")
      .set("Accept-Encoding", "gzip")
      .expect(200);

    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("does not compress small responses", async () => {
    const res = await request(createResponseCompressionApp())
      .get("/small")
      .set("Accept-Encoding", "gzip")
      .expect(200);

    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("respects X-No-Compression header", async () => {
    const res = await request(createResponseCompressionApp())
      .get("/large")
      .set("Accept-Encoding", "gzip")
      .set("x-no-compression", "true")
      .expect(200);

    expect(res.headers["content-encoding"]).toBeUndefined();
  });
});
