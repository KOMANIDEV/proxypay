/**
 * Idempotency middleware.
 *
 * Clients send an `Idempotency-Key` header on mutating requests. The first
 * request claims the key and its successful response is stored; any retry with
 * the same key replays that stored response instead of executing again, so a
 * retried payment never produces a second ledger entry.
 *
 * Keys expire after IDEMPOTENCY_KEY_TTL_HOURS (default 24) and expired rows are
 * removed by the daily cleanup job.
 */

import crypto from "node:crypto";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { pool } from "../config/database";

const IDEMPOTENCY_TTL_HOURS = Number(
  process.env.IDEMPOTENCY_KEY_TTL_HOURS || 24,
);

const MAX_KEY_LENGTH = 255;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH"]);

interface IdempotencyRow {
  request_hash: string;
  state: "in_progress" | "completed";
  status_code: number | null;
  response_body: unknown;
}

function hashRequest(req: Request): string {
  return crypto
    .createHash("sha256")
    .update(`${req.method}:${req.originalUrl}:${JSON.stringify(req.body ?? {})}`)
    .digest("hex");
}

function expiryDate(): Date {
  return new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
}

/**
 * Claims the key. Returns null when the claim succeeded (this is the first
 * request), or the existing row when the key is already in use.
 */
async function claimKey(
  key: string,
  req: Request,
  requestHash: string,
): Promise<IdempotencyRow | null> {
  // Drop the row first if it has already expired so the key can be reused.
  await pool.query(
    `DELETE FROM idempotency_keys WHERE key = $1 AND expires_at <= CURRENT_TIMESTAMP`,
    [key],
  );

  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (key, method, path, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO NOTHING`,
    [key, req.method, req.originalUrl.slice(0, 512), requestHash, expiryDate()],
  );

  if ((inserted?.rowCount ?? 0) === 1) {
    return null;
  }

  const existing = await pool.query(
    `SELECT request_hash, state, status_code, response_body
     FROM idempotency_keys WHERE key = $1`,
    [key],
  );

  return (existing.rows[0] as IdempotencyRow) ?? null;
}

async function storeResponse(
  key: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
     SET state = 'completed', status_code = $2, response_body = $3
     WHERE key = $1`,
    [key, statusCode, JSON.stringify(body ?? null)],
  );
}

async function releaseKey(key: string): Promise<void> {
  await pool.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key]);
}

/**
 * Captures the outgoing JSON response: successful ones are stored for replay,
 * failed ones release the key so the client may retry with it.
 */
function captureResponse(key: string, res: Response): void {
  const originalJson = res.json.bind(res);

  res.json = (body: unknown) => {
    const statusCode = res.statusCode;
    const persist =
      statusCode >= 200 && statusCode < 300
        ? storeResponse(key, statusCode, body)
        : releaseKey(key);

    void persist.catch((err) =>
      console.warn(
        `[idempotency] Failed to persist result for key ${key}:`,
        err instanceof Error ? err.message : err,
      ),
    );

    return originalJson(body);
  };
}

export function idempotency(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!MUTATING_METHODS.has(req.method)) {
      return next();
    }

    const key = req.header("Idempotency-Key")?.trim();
    if (!key) {
      return next();
    }

    if (key.length > MAX_KEY_LENGTH) {
      return res.status(400).json({
        error: `Idempotency-Key must be ${MAX_KEY_LENGTH} characters or fewer`,
      });
    }

    const requestHash = hashRequest(req);

    let existing: IdempotencyRow | null;
    try {
      existing = await claimKey(key, req, requestHash);
    } catch (err) {
      // Fail open — an idempotency store outage must not block payments.
      console.warn(
        "[idempotency] Store unavailable, processing without replay protection:",
        err instanceof Error ? err.message : err,
      );
      return next();
    }

    if (!existing) {
      captureResponse(key, res);
      return next();
    }

    if (existing.request_hash !== requestHash) {
      return res.status(409).json({
        error:
          "Idempotency-Key was already used with a different request payload",
      });
    }

    if (existing.state === "in_progress") {
      return res.status(409).json({
        error: "A request with this Idempotency-Key is still being processed",
      });
    }

    res.setHeader("Idempotent-Replayed", "true");
    return res.status(existing.status_code ?? 200).json(existing.response_body);
  };
}
