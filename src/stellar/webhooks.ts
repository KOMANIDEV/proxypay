import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { notifyTransactionWebhook, WebhookEvent } from "../services/webhook";
import { enqueueSepWebhook } from "../services/stellar/webhooks";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import { redisClient } from "../config/redis";

const router = Router();
const transactionModel = new TransactionModel();

// Rate-limit ingest traffic before signature verification and DB writes.
router.use(ingestRateLimiter);

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const memoSchema = z.union([
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("id"), value: z.string() }),
  z.object({ type: z.literal("hash"), value: z.string() }),
]);

const stellarWebhookSchema = z.object({
  transaction_hash: z.string().min(1),
  status: z.enum(["success", "failed"]),
  ledger: z.number().int().positive().optional(),
  timestamp: z.string(),
  // Unique per delivery — used to reject replayed webhooks.
  nonce: z.string().min(8).max(128),
  source_account: z.string().optional(),
  destination_account: z.string().optional(),
  amount: z.string().optional(),
  memo: memoSchema.optional(),
});

export type StellarWebhookPayload = z.infer<typeof stellarWebhookSchema>;

/** Extract a plain string reference from any memo type. */
function parseMemoValue(memo: z.infer<typeof memoSchema>): string {
  return memo.value;
}

function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = signature.substring(7);
  const computedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (expectedSignature.length !== computedSignature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(computedSignature),
  );
}

// ─── Replay protection ───────────────────────────────────────────────────────
//
// Providers must include a `timestamp` (ISO-8601) and a unique `nonce` in the
// webhook payload. Timestamps outside the acceptance window are rejected, and
// every nonce is remembered for the length of that window so an identical
// delivery cannot be replayed. Nonces are stored in Redis when available so the
// protection holds across instances, with an in-memory fallback.

export const WEBHOOK_MAX_AGE_MS = parseInt(
  process.env.STELLAR_WEBHOOK_MAX_AGE_MS || String(5 * 60 * 1000),
  10,
);
export const WEBHOOK_NONCE_TTL_MS = parseInt(
  process.env.STELLAR_WEBHOOK_NONCE_TTL_MS || String(WEBHOOK_MAX_AGE_MS),
  10,
);

const nonceCache = new Map<string, number>(); // nonce -> expiry (epoch ms)

function purgeExpiredNonces(now: number): void {
  for (const [nonce, expiry] of nonceCache) {
    if (expiry <= now) nonceCache.delete(nonce);
  }
}

/** Clears the in-memory nonce cache — used by tests. */
export function resetNonceStore(): void {
  nonceCache.clear();
}

/**
 * True when the payload timestamp sits inside the replay window. Both stale and
 * far-future timestamps are rejected, so a forged clock cannot bypass the check.
 */
export function isTimestampFresh(
  timestamp: string,
  now: number = Date.now(),
  maxAgeMs: number = WEBHOOK_MAX_AGE_MS,
): boolean {
  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) return false;
  return Math.abs(now - value) <= maxAgeMs;
}

/**
 * Atomically records a nonce for the replay window. Returns `accepted: false`
 * when the nonce was already seen, which means the delivery is a replay.
 */
export async function consumeNonce(
  nonce: string,
  now: number = Date.now(),
): Promise<{ accepted: boolean }> {
  purgeExpiredNonces(now);

  if (nonceCache.has(nonce)) {
    return { accepted: false };
  }

  try {
    if (redisClient.isOpen) {
      const stored = await redisClient.set(
        `stellar-webhook:nonce:${nonce}`,
        "1",
        { NX: true, PX: WEBHOOK_NONCE_TTL_MS },
      );
      if (stored !== "OK") return { accepted: false };
      nonceCache.set(nonce, now + WEBHOOK_NONCE_TTL_MS);
      return { accepted: true };
    }
  } catch (err) {
    console.warn(
      "[stellar-webhook] Nonce store unavailable, using in-memory fallback",
      err,
    );
  }

  nonceCache.set(nonce, now + WEBHOOK_NONCE_TTL_MS);
  return { accepted: true };
}

router.post("/webhook", async (req: RawBodyRequest, res: Response) => {
  const webhookSecret = process.env.STELLAR_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[stellar-webhook] STELLAR_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Webhook processing not configured" });
  }

  const signature = req.headers["x-stellar-signature"] as string | undefined;
  const rawPayload = req.rawBody?.toString() ?? JSON.stringify(req.body);

  if (!verifyWebhookSignature(rawPayload, signature, webhookSecret)) {
    console.warn("[stellar-webhook] Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const parseResult = stellarWebhookSchema.safeParse(req.body);
  if (!parseResult.success) {
    console.warn("[stellar-webhook] Validation failed", parseResult.error.issues);
    return res.status(400).json({
      error: "Validation failed",
      details: parseResult.error.issues,
    });
  }

  const payload = parseResult.data;

  if (!isTimestampFresh(payload.timestamp)) {
    console.warn(
      "[stellar-webhook] Stale or future timestamp, possible replay",
      {
        timestamp: payload.timestamp,
        windowMs: WEBHOOK_MAX_AGE_MS,
      },
    );
    return res.status(401).json({
      error: "Stale webhook timestamp",
      code: "STALE_TIMESTAMP",
    });
  }

  const nonceResult = await consumeNonce(payload.nonce);
  if (!nonceResult.accepted) {
    console.warn("[stellar-webhook] Replay detected for nonce", {
      nonce: payload.nonce,
    });
    return res.status(409).json({
      error: "Duplicate webhook delivery",
      code: "REPLAY_DETECTED",
    });
  }

  const newStatus =
    payload.status === "success"
      ? TransactionStatus.Completed
      : TransactionStatus.Failed;

  try {
    let transactions = await transactionModel.findByMetadata({
      stellar_hash: payload.transaction_hash,
    });

    // Fall back to memo-based lookup if no match by hash
    if (transactions.length === 0 && payload.memo) {
      const memoValue = parseMemoValue(payload.memo);
      const tx = await transactionModel.findByReferenceNumber(memoValue);
      transactions = tx ? [tx] : [];

      if (transactions.length === 0) {
        transactions = await transactionModel.findByMetadata({
          memo: memoValue,
        });
      }
    }

    if (transactions.length === 0) {
      console.warn(
        `[stellar-webhook] No transaction found for hash ${payload.transaction_hash}`,
      );
      return res.status(404).json({
        error: "Transaction not found",
        hash: payload.transaction_hash,
      });
    }

    let updated = 0;

    for (const transaction of transactions) {
      if (
        transaction.status === TransactionStatus.Completed ||
        transaction.status === TransactionStatus.Failed
      ) {
        console.log(
          `[stellar-webhook] Skipping transaction ${transaction.id} - already in terminal state ${transaction.status}`,
        );
        continue;
      }

      await transactionModel.updateStatus(transaction.id, newStatus);

      await transactionModel.patchMetadata(transaction.id, {
        stellar_ledger: payload.ledger,
        stellar_hash: payload.transaction_hash,
        webhook_processed_at: new Date().toISOString(),
      });

      const webhookEvent: WebhookEvent =
        newStatus === TransactionStatus.Completed
          ? "transaction.completed"
          : "transaction.failed";

      await notifyTransactionWebhook(transaction.id, webhookEvent, {
        transactionModel,
      });

      // SEP-31 Webhook Integration
      const sep31Meta = (transaction.metadata as any)?.sep31;
      if (sep31Meta) {
        const newSep31Status = newStatus === TransactionStatus.Completed ? "completed" : "failed";
        const callbackUrl = sep31Meta.callback || process.env.SEP31_WEBHOOK_URL || process.env.WEBHOOK_URL;
        if (callbackUrl) {
          await enqueueSepWebhook(
            transaction.id,
            newSep31Status,
            callbackUrl,
            {
              id: transaction.id,
              status: newSep31Status,
              amount: transaction.amount,
              stellar_transaction_id: payload.transaction_hash,
              started_at: transaction.createdAt,
              completed_at: new Date().toISOString(),
              stellar_memo: sep31Meta.memo,
              stellar_memo_type: sep31Meta.memo_type,
            }
          ).catch((err) =>
            console.error(`[sep31-webhook] Error enqueuing webhook:`, err)
          );
        }
      }

      console.log(
        `[stellar-webhook] Updated transaction ${transaction.id} to ${newStatus}`,
      );

      updated++;
    }

    return res.status(200).json({
      success: true,
      updated,
    });
  } catch (error) {
    console.error("[stellar-webhook] Processing error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
