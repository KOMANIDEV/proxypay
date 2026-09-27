import { Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import logger from "../../utils/logger";

const QUEUE_NAME = "mobile-money-provider-calls";
const DEAD_LETTER_QUEUE_NAME = `${QUEUE_NAME}-dlq`;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });
const queueEvents = new QueueEvents(QUEUE_NAME, { connection });
const deadLetterQueue = new Queue(DEAD_LETTER_QUEUE_NAME, { connection });

const TAKE_TOKEN_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'tokens', 'timestamp')
local tokens = tonumber(values[1])
local timestamp = tonumber(values[2])
if not tokens then tokens = capacity end
if not timestamp then timestamp = now end
local elapsed = math.max(0, now - timestamp)
tokens = math.min(capacity, tokens + elapsed * rate)
local granted = 0
local wait_ms = 0
if tokens >= requested then
  tokens = tokens - requested
  granted = 1
else
  wait_ms = math.ceil((requested - tokens) / rate)
end
redis.call('HSET', key, 'tokens', tokens, 'timestamp', now)
redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 1000) + 60000)
return { granted, wait_ms }
`;

export type ProviderCall =
  | { operation: "payment"; provider: string; phoneNumber: string; amount: string }
  | { operation: "payout"; provider: string; phoneNumber: string; amount: string }
  | { operation: "batchPayout"; provider: string; items: unknown[] };

/**
 * A provider call that could not be accepted for processing (queue saturated)
 * or that exhausted all retry attempts. Captured in the dead-letter queue so
 * the request is never silently lost (Issue #625).
 */
export interface DeadLetterEntry {
  id: string;
  provider: string;
  operation: ProviderCall["operation"];
  payload: ProviderCall;
  reason: string;
  /** ISO timestamp of when the request was dead-lettered. */
  failedAt: string;
  attemptsMade: number;
}

/** Thrown when a provider call could not be queued and was dead-lettered. */
export class ProviderThrottleQueueFullError extends Error {
  constructor(
    message: string,
    public readonly deadLetterId: string | null = null,
  ) {
    super(message);
    this.name = "ProviderThrottleQueueFullError";
  }
}

/** Maximum number of pending jobs before new calls are dead-lettered. */
export function getMaxQueueSize(): number {
  const configured = Number(process.env.PROVIDER_THROTTLE_MAX_QUEUE_SIZE);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_MAX_QUEUE_SIZE;
}

/** Current number of pending (waiting + active + delayed) provider calls. */
async function queueDepth(): Promise<number> {
  const [waiting, active, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getDelayedCount(),
  ]);
  return waiting + active + delayed;
}

/**
 * Persist a dropped/failed provider call in the dead-letter queue and emit a
 * structured log line containing the timestamp, provider and full payload.
 */
async function moveToDeadLetter(
  call: ProviderCall,
  reason: string,
  attemptsMade = 0,
): Promise<string | null> {
  const failedAt = new Date().toISOString();
  try {
    const job = await deadLetterQueue.add("dead-letter", {
      provider: call.provider,
      operation: call.operation,
      payload: call,
      reason,
      failedAt,
      attemptsMade,
    });
    logger.error(
      {
        event: "provider_throttle_dead_letter",
        deadLetterId: job.id,
        timestamp: failedAt,
        provider: call.provider,
        operation: call.operation,
        reason,
        attemptsMade,
        payload: call,
      },
      "[providerThrottle] request moved to dead-letter queue",
    );
    return job.id === undefined ? null : String(job.id);
  } catch (err) {
    logger.error(
      { err, timestamp: failedAt, provider: call.provider, payload: call },
      "[providerThrottle] failed to persist dead-letter entry",
    );
    return null;
  }
}

// ─── Dead-letter queue administration ────────────────────────────────────────

/** List dead-lettered provider calls, newest first. */
export async function listDeadLetters(
  limit = 50,
  offset = 0,
): Promise<DeadLetterEntry[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const jobs = await deadLetterQueue.getJobs(
    ["waiting", "delayed", "paused", "failed"],
    Math.max(0, offset),
    Math.max(0, offset) + boundedLimit - 1,
    false,
  );

  return jobs.map((job) => {
    const data = job.data as Omit<DeadLetterEntry, "id">;
    return { ...data, id: String(job.id) };
  });
}

/** Total number of dead-lettered provider calls. */
export async function getDeadLetterCount(): Promise<number> {
  return deadLetterQueue.getWaitingCount();
}

/**
 * Re-enqueue a single dead-lettered provider call. The job is only removed
 * from the DLQ once it has been accepted back onto the throttle queue.
 */
export async function replayDeadLetter(
  id: string,
): Promise<{ replayed: boolean; deadLetterId: string; error?: string }> {
  const job = await deadLetterQueue.getJob(id);
  if (!job) {
    return { replayed: false, deadLetterId: id, error: "Dead-letter item not found" };
  }

  const entry = job.data as DeadLetterEntry;
  try {
    // Bypass the cap on replay: the operator explicitly asked for this item.
    await enqueueProviderCall(entry.payload, { bypassQueueLimit: true });
    await job.remove();
    logger.info(
      { event: "provider_throttle_dead_letter_replay", deadLetterId: id, provider: entry.provider },
      "[providerThrottle] dead-letter item replayed",
    );
    return { replayed: true, deadLetterId: id };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown replay error";
    logger.error(
      { err, deadLetterId: id },
      "[providerThrottle] dead-letter replay failed",
    );
    return { replayed: false, deadLetterId: id, error };
  }
}

/** Replay up to `limit` dead-lettered provider calls. */
export async function replayAllDeadLetters(
  limit = 100,
): Promise<{ replayed: number; failed: number }> {
  const entries = await listDeadLetters(limit);
  let replayed = 0;
  let failed = 0;

  for (const entry of entries) {
    const result = await replayDeadLetter(entry.id);
    if (result.replayed) replayed++;
    else failed++;
  }

  return { replayed, failed };
}

function settings(provider: string) {
  const prefix = provider.toUpperCase();
  const rate = Number(process.env[`${prefix}_MOMO_TOKENS_PER_SECOND`] || "5");
  const capacity = Number(process.env[`${prefix}_MOMO_BUCKET_CAPACITY`] || String(Math.max(1, rate)));
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(`Invalid ${prefix} MoMo token bucket configuration`);
  }
  return { rate, capacity };
}

function enabled(): boolean {
  if (process.env.PROVIDER_THROTTLING_ENABLED === "false") return false;
  return process.env.NODE_ENV !== "test" || process.env.PROVIDER_THROTTLING_ENABLED === "true";
}

async function takeToken(provider: string, requested = 1): Promise<void> {
  const { rate, capacity } = settings(provider);
  const result = (await connection.eval(
    TAKE_TOKEN_SCRIPT,
    1,
    `provider-throttle:${provider}`,
    String(Date.now()),
    String(rate / 1000),
    String(capacity),
    String(requested),
  )) as [number, number];
  if (Number(result[0]) === 1) return;
  await new Promise((resolve) => setTimeout(resolve, Number(result[1])));
  return takeToken(provider, requested);
}

let workerStarted = false;
function ensureWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const call = job.data as ProviderCall;
      await takeToken(
        call.provider,
        call.operation === "batchPayout" ? Math.max(1, call.items.length) : 1,
      );
      // Load the compiled implementation directly to avoid re-enqueueing this job.
      const { MobileMoneyService: BaseMobileMoneyService } = require("./mobileMoneyService_impl.js");
      const service = new BaseMobileMoneyService();
      if (call.operation === "payment") return service.initiatePayment(call.provider, call.phoneNumber, call.amount);
      if (call.operation === "payout") return service.sendPayout(call.provider, call.phoneNumber, call.amount);
      return service.sendBatchPayout(call.provider, call.items);
    },
    { connection, concurrency: Number(process.env.PROVIDER_THROTTLE_CONCURRENCY || "10") },
  );

  // Requests that exhaust every retry attempt are dead-lettered instead of
  // being discarded by BullMQ's removeOnFail retention (Issue #625).
  worker.on("failed", (job, err) => {
    if (!job) return;
    const maxAttempts = Number(job.opts?.attempts ?? 1);
    const attemptsMade = job.attemptsMade ?? 0;
    if (attemptsMade < maxAttempts) return; // retries still pending
    void moveToDeadLetter(
      job.data as ProviderCall,
      err?.message ?? "Provider call failed after all retry attempts",
      attemptsMade,
    );
  });
}

export async function enqueueProviderCall<T>(
  call: ProviderCall,
  options: { bypassQueueLimit?: boolean } = {},
): Promise<T> {
  if (!enabled()) {
    const { MobileMoneyService: BaseMobileMoneyService } = require("./mobileMoneyService_impl.js");
    const service = new BaseMobileMoneyService();
    if (call.operation === "payment") return service.initiatePayment(call.provider, call.phoneNumber, call.amount) as Promise<T>;
    if (call.operation === "payout") return service.sendPayout(call.provider, call.phoneNumber, call.amount) as Promise<T>;
    return service.sendBatchPayout(call.provider, call.items) as Promise<T>;
  }

  ensureWorker();

  if (!options.bypassQueueLimit) {
    const maxQueueSize = getMaxQueueSize();
    if ((await queueDepth()) >= maxQueueSize) {
      const reason = `Provider throttle queue is full (capacity ${maxQueueSize})`;
      const deadLetterId = await moveToDeadLetter(call, reason);
      throw new ProviderThrottleQueueFullError(reason, deadLetterId);
    }
  }

  const job = await queue.add("provider-call", call, {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: Number(process.env.PROVIDER_THROTTLE_JOB_ATTEMPTS || "3"),
    backoff: { type: "exponential", delay: 1000 },
  });
  return job.waitUntilFinished(queueEvents) as Promise<T>;
}

export async function closeProviderThrottle(): Promise<void> {
  await Promise.all([
    queue.close(),
    queueEvents.close(),
    deadLetterQueue.close(),
    connection.quit(),
  ]);
}
