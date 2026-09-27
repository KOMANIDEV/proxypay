import { Router } from "express";
import { EventEmitter } from "events";
import { createClient, RedisClientType } from "redis";
import { requireAuth } from "../middleware/auth";
import { TRANSACTION_UPDATES_CHANNEL } from "../websocket/websocketManager";

interface TransactionUpdateEvent {
  transactionId: string;
  userId?: string | null;
  message: { type: string; data: Record<string, unknown> };
}

// Fan-out emitter shared by all SSE connections in this process, so we only
// need a single Redis subscriber regardless of how many clients are streaming.
const updatesEmitter = new EventEmitter();
updatesEmitter.setMaxListeners(0);

let subscribeOnce: Promise<void> | null = null;

async function ensureSubscribed(): Promise<void> {
  if (subscribeOnce) return subscribeOnce;

  subscribeOnce = (async () => {
    if (!process.env.REDIS_URL) {
      console.warn(
        "[stream] REDIS_URL not configured — transaction stream will not receive live updates",
      );
      return;
    }

    const client = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    await client.connect();
    await client.subscribe(TRANSACTION_UPDATES_CHANNEL, (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as TransactionUpdateEvent;
        updatesEmitter.emit("update", parsed);
      } catch (err) {
        console.error("[stream] Failed to parse transaction update:", err);
      }
    });
  })();

  return subscribeOnce;
}

const HEARTBEAT_INTERVAL_MS = 15_000;

export const transactionStreamRoutes = Router();

/**
 * GET /api/stream/transactions
 * Server-Sent Events endpoint streaming the authenticated user's own
 * transaction updates. Optional `?type=deposit|withdraw` filters by
 * transaction type.
 */
transactionStreamRoutes.get("/transactions", requireAuth, async (req, res) => {
  const userId = req.jwtUser?.userId;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Long-lived stream — exempt from the global request timeout.
  (req as unknown as { clearTimeout?: () => void }).clearTimeout?.();

  await ensureSubscribed();

  const typeFilter =
    typeof req.query.type === "string" ? req.query.type : undefined;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Ask clients to wait 3s before reconnecting on drop, for seamless resume.
  res.write("retry: 3000\n\n");

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("connected", { userId, subscribedAt: new Date().toISOString() });

  const onUpdate = (evt: TransactionUpdateEvent) => {
    if (evt.userId && evt.userId !== userId) return;
    if (typeFilter && evt.message?.data?.type && evt.message.data.type !== typeFilter) {
      return;
    }
    send(evt.message?.type || "transaction.updated", evt.message?.data ?? {});
  };

  updatesEmitter.on("update", onUpdate);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_INTERVAL_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    updatesEmitter.off("update", onUpdate);
    res.end();
  });
});
