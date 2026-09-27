import { createHmac } from "crypto";
import { webhookPayloadSchema, flatWebhookPayloadSchema } from "./webhookSchema";
import { gzip } from "zlib";
import { promisify } from "util";
import { Transaction, WebhookDeliveryUpdate } from "../models/transaction";
import {
  CIRCUIT_HALF_OPEN,
  CIRCUIT_OPEN,
  type WebhookCircuitBreaker,
  getWebhookCircuitBreaker,
} from "./webhookCircuitBreaker";
import {
  webhookRetryAttemptsTotal,
  webhookDeliveryDurationSeconds,
  webhookDeliveryRetriesTotal,
  webhookBackoffDelaySeconds,
  webhookCircuitBreakerSkippedTotal,
} from "../utils/metrics";
import {
  WebhookCircuitBreaker,
  WebhookCircuitBreakerOptions,
  WebhookCircuitBreakerRegistry,
} from "./webhookCircuitBreaker";

const gzipAsync = promisify(gzip);

const WEBHOOK_CIRCUIT_BREAKER_RECOVERY_MS = 24 * 60 * 60 * 1000; // 24 hours

export type WebhookEvent = "transaction.completed" | "transaction.failed" | "transaction.cancelled" | "transaction.pending";
export type WebhookDeliveryStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "skipped";

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, string>;
}

export type WebhookOutboxStatus =
  | "pending"
  | "processing"
  | "delivered"
  | "failed";

export interface WebhookOutboxEntry {
  id: string;
  eventType: string;
  payload: WebhookPayload | FlatWebhookPayload;
  status: WebhookOutboxStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: Date;
  nextAttemptAt?: Date;
  /**
   * Timestamp after which the delivery is considered unconfirmed if no ACK has
   * been received.  Set to `Date.now() + ackTimeoutMs` when status transitions
   * to "processing".  The outbox processor re-queues the entry if it remains
   * in "processing" past this deadline (handles lost ACKs / crashed workers).
   */
  ackDeadlineAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  compress?: boolean;
}

export interface FlatWebhookPayload {
  event_id: string;
  event_type: WebhookEvent;
  timestamp: string;
  transaction_id: string;
  reference_number: string;
  transaction_type: "deposit" | "withdraw";
  amount: string;
  currency: string;
  phone_number: string;
  provider: string;
  stellar_address: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  user_id?: string;
  notes?: string;
  tags?: string;
  created_at: string;
  updated_at?: string;
  metadata_key?: string;
  metadata_value?: string;
  webhook_delivery_status?: string;
  webhook_delivered_at?: string;
}

export interface WebhookDeliveryResult {
  status: Exclude<WebhookDeliveryStatus, "pending">;
  attempts: number;
  statusCode?: number;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  lastError?: string | null;
}

export interface WebhookLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface WebhookServiceOptions {
  fetchImpl?: typeof fetch;
  webhookUrl?: string;
  webhookSecret?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  logger?: WebhookLogger;
  /** When true, payloads are Gzip-compressed before sending (Content-Encoding: gzip) */
  compress?: boolean;
  /**
   * How long (ms) to wait for a consumer ACK before treating the delivery as
   * unconfirmed and re-queuing the outbox entry.  Defaults to 60 000 ms (60 s).
   * Only applies to processOutbox(); direct send* methods are unaffected.
   */
  ackTimeoutMs?: number;
}

interface WebhookTransactionModel {
  findById(id: string): Promise<Transaction | null>;
  updateWebhookDelivery?(
    id: string,
    delivery: WebhookDeliveryUpdate,
  ): Promise<void>;
}

export interface WebhookOutboxModel {
  insert(entry: Omit<WebhookOutboxEntry, "id" | "createdAt">): Promise<string>;
  findNextToProcess(limit: number): Promise<WebhookOutboxEntry[]>;
  update(id: string, update: Partial<WebhookOutboxEntry>): Promise<void>;
  delete(id: string): Promise<void>;
  /** Optional: move a permanently-failed entry to the DLQ. */
  moveToDLQ?(id: string, reason: string): Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter and max cap.
 * @param baseDelayMs - Base delay in milliseconds
 * @param attempt - Current attempt number (1-indexed)
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @param jitterFactor - Jitter factor (0-1) to add randomness
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs: number,
  jitterFactor: number,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitter = cappedDelay * jitterFactor * Math.random();
  return Math.floor(cappedDelay + jitter);
}

/**
 * Determine if an error is retryable.
 * Retry on: network errors, timeouts, 5xx server errors
 * Don't retry on: 4xx client errors (except 429 Too Many Requests)
 * @param error - The error that occurred
 * @param statusCode - HTTP status code if available
 * @returns true if the request should be retried
 */
function isRetryableError(
  error: unknown,
  statusCode?: number,
): boolean {
  if (statusCode !== undefined) {
    // Retry on 429 (rate limited) and 5xx server errors
    if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
      return true;
    }
    // Don't retry on other 4xx client errors
    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
  }
  // Retry on network errors (no status code)
  return true;
}

function getStringValue(
  transaction: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = transaction[key];
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

function toWebhookData(transaction: Transaction): Record<string, string> {
  const record = transaction as unknown as Record<string, unknown>;
  const data: Record<string, string> = {};
  const mappings: Array<[string, string[]]> = [
    ["id", ["id"]],
    ["referenceNumber", ["referenceNumber", "reference_number"]],
    ["type", ["type"]],
    ["amount", ["amount"]],
    ["status", ["status"]],
    ["phoneNumber", ["phoneNumber", "phone_number"]],
    ["provider", ["provider"]],
    ["stellarAddress", ["stellarAddress", "stellar_address"]],
    ["userId", ["userId", "user_id"]],
  ];
  for (const [targetKey, sourceKeys] of mappings) {
    const value = getStringValue(record, ...sourceKeys);
    if (value) data[targetKey] = value;
  }
  return data;
}

/** Gzip-compress the payload if compression is enabled. Returns body + extra headers. */
async function prepareBody(
  rawPayload: string,
  compress: boolean,
): Promise<{ body: Buffer | string; extraHeaders: Record<string, string> }> {
  if (compress) {
    const body = await gzipAsync(Buffer.from(rawPayload, "utf-8"));
    return { body, extraHeaders: { "Content-Encoding": "gzip" } };
  }
  return { body: rawPayload, extraHeaders: {} };
}

export class WebhookService {
  private readonly fetchImpl: typeof fetch;
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterFactor: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly logger: WebhookLogger;
  /** Whether to Gzip-compress outgoing webhook payloads */
  readonly compress: boolean;
  /**
   * How long (ms) to wait for consumer ACK before re-queuing the outbox entry.
   * Default: 60 000 ms (60 seconds).
   */
  private readonly ackTimeoutMs: number;

  constructor(options: WebhookServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webhookUrl = options.webhookUrl ?? process.env.WEBHOOK_URL ?? "";
    this.webhookSecret =
      options.webhookSecret ?? process.env.WEBHOOK_SECRET ?? "";
    this.maxAttempts = options.maxAttempts
      ?? (parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || "", 10) || 3);
    this.baseDelayMs = options.baseDelayMs
      ?? (parseInt(process.env.WEBHOOK_BASE_DELAY_MS || "", 10) || 500);
    this.maxDelayMs = options.maxDelayMs
      ?? (parseInt(process.env.WEBHOOK_MAX_DELAY_MS || "", 10) || 30000);
    this.jitterFactor = options.jitterFactor
      ?? (parseFloat(process.env.WEBHOOK_JITTER_FACTOR || "") || 0.2);
    this.sleepImpl = options.sleep ?? wait;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
    this.compress = options.compress ?? (process.env.WEBHOOK_COMPRESSION === "true");
    this.ackTimeoutMs = options.ackTimeoutMs
      ?? (parseInt(process.env.WEBHOOK_ACK_TIMEOUT_MS || "", 10) || 60_000);
  }

  buildPayload(event: WebhookEvent, transaction: Transaction): WebhookPayload {
    return {
      event,
      timestamp: this.now().toISOString(),
      data: toWebhookData(transaction),
    };
  }

  buildFlatPayload(
    event: WebhookEvent,
    transaction: Transaction,
  ): FlatWebhookPayload {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const payload: FlatWebhookPayload = {
      event_id: eventId,
      event_type: event,
      timestamp: this.now().toISOString(),
      transaction_id: transaction.id,
      reference_number: transaction.referenceNumber,
      transaction_type: transaction.type as "deposit" | "withdraw",
      amount: transaction.amount,
      currency: (transaction as any).currency || "USD",
      phone_number: transaction.phoneNumber,
      provider: transaction.provider,
      stellar_address: transaction.stellarAddress,
      status: transaction.status as "pending" | "completed" | "failed" | "cancelled",
      user_id: transaction.userId || undefined,
      notes: transaction.notes || undefined,
      tags: transaction.tags ? transaction.tags.join(",") : undefined,
      created_at: transaction.createdAt.toISOString(),
      updated_at: transaction.updatedAt
        ? transaction.updatedAt.toISOString()
        : undefined,
      webhook_delivery_status: (transaction as any).webhook_delivery_status,
      webhook_delivered_at: (transaction as any).webhook_delivered_at
        ? (transaction as any).webhook_delivered_at.toISOString()
        : undefined,
    };
    if (transaction.metadata && typeof transaction.metadata === "object") {
      const entries = Object.entries(transaction.metadata);
      if (entries.length > 0) {
        payload.metadata_key = entries[0][0];
        payload.metadata_value = String(entries[0][1]);
      }
    }
    return payload;
  }

  signPayload(rawPayload: string): string {
    return `sha256=${createHmac("sha256", this.webhookSecret).update(rawPayload).digest("hex")}`;
  }

  async sendTransactionEvent(
    event: WebhookEvent,
    transaction: Transaction,
  ): Promise<WebhookDeliveryResult> {
    if (!this.webhookUrl) {
      const message = "WEBHOOK_URL is not configured";
      this.logger.warn(`[webhook] ${message}`);
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }
    if (!this.webhookSecret) {
      const message = "WEBHOOK_SECRET is not configured";
      this.logger.warn(`[webhook] ${message}`);
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }

    // Consulted before any network call, which is the entire point: an open
    // breaker must cost one map lookup, not `maxAttempts` round trips.
    const circuit = this.circuitBlocksDelivery();
    if (circuit === "open") {
      const message = "Circuit breaker is open for this webhook destination";
      this.logger.warn(
        `[webhook] delivery suppressed event=${event} transactionId=${transaction.id}: ${message}`,
      );
      webhookCircuitBreakerSkippedTotal.inc({ event_type: event });
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }

    const payload = this.buildPayload(event, transaction);
    const validation = webhookPayloadSchema.safeParse(payload);
    if (!validation.success) {
      this.logger.warn(`[webhook] payload validation failed: ${validation.error}`);
      return { status: "failed", attempts: 0, lastAttemptAt: null, deliveredAt: null, lastError: "Payload validation failed" };
    }
    const rawPayload = JSON.stringify(payload);
    const signature = this.signPayload(rawPayload);
    const { body, extraHeaders } = await prepareBody(rawPayload, this.compress);

    let lastError: string | null = null;
    let lastStatusCode: number | undefined;
    let lastAttemptAt: Date | null = null;
    let finalAttempt = 0;
    const deliveryStart = Date.now();

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      lastAttemptAt = this.now();
      finalAttempt = attempt;
      try {
        const response = await this.fetchImpl(this.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            ...extraHeaders,
          },
          body: body as any,
        });
        lastStatusCode = response.status;
        if (!response.ok)
          throw new Error(`Webhook responded with HTTP ${response.status}`);
        this.logger.log(
          `[webhook] delivered event=${event} transactionId=${payload.data.id} attempt=${attempt} compressed=${this.compress}`,
        );

        // Track delivery duration
        const durationSecs = (Date.now() - deliveryStart) / 1000;
        webhookDeliveryDurationSeconds.observe({ event_type: event, status: "delivered" }, durationSecs);

        // Track if retries were needed
        if (attempt > 1) {
          webhookDeliveryRetriesTotal.inc({ event_type: event, final_status: "delivered" });
        }

        // A delivery that lands closes the breaker, including when it was the
        // half-open probe: that is the evidence the destination is back.
        this.circuitBreaker.recordSuccess(this.webhookUrl);

        return {
          status: "delivered",
          attempts: attempt,
          statusCode: response.status,
          lastAttemptAt,
          deliveredAt: lastAttemptAt,
          lastError: null,
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : "Unknown webhook error";
        this.logger.warn(
          `[webhook] delivery failed event=${event} transactionId=${payload.data.id} attempt=${attempt}/${this.maxAttempts}: ${lastError}`,
        );

        // Track retry attempt
        webhookRetryAttemptsTotal.inc({
          event_type: event,
          attempt: String(attempt),
          status_code: String(lastStatusCode || 0),
        });

        // Check if we should retry based on error type
        if (attempt < this.maxAttempts && isRetryableError(error, lastStatusCode)) {
          const delayMs = calculateBackoffDelay(
            this.baseDelayMs,
            attempt,
            this.maxDelayMs,
            this.jitterFactor,
          );
          webhookBackoffDelaySeconds.observe({ event_type: event, attempt: String(attempt) }, delayMs / 1000);
          this.logger.log(
            `[webhook] retrying in ${delayMs}ms event=${event} transactionId=${payload.data.id} attempt=${attempt + 1}/${this.maxAttempts}`,
          );
          await this.sleepImpl(delayMs);
        } else if (attempt < this.maxAttempts) {
          // Non-retryable error, break early
          this.logger.warn(
            `[webhook] non-retryable error, stopping retries event=${event} transactionId=${payload.data.id}: ${lastError}`,
          );
          break;
        }
      }
    }

    this.logger.error(
      `[webhook] delivery exhausted event=${event} transactionId=${payload.data.id}: ${lastError}`,
    );

    // Track failed delivery
    const durationSecs = (Date.now() - deliveryStart) / 1000;
    webhookDeliveryDurationSeconds.observe({ event_type: event, status: "failed" }, durationSecs);
    webhookDeliveryRetriesTotal.inc({ event_type: event, final_status: "failed" });
    this.onDeliveryFailure(lastError);

    // The retries are over, so the whole delivery is one failure as far as the
    // breaker is concerned. Counting each attempt would trip it on a single
    // flaky delivery; this is the "that endpoint is broken" signal.
    this.circuitBreaker.recordFailure(this.webhookUrl, lastError, circuit === "probe");

    return {
      status: "failed",
      attempts: finalAttempt,
      statusCode: lastStatusCode,
      lastAttemptAt,
      deliveredAt: null,
      lastError,
    };
  }

  async sendFlatTransactionEvent(
    event: WebhookEvent,
    transaction: Transaction,
  ): Promise<WebhookDeliveryResult> {
    if (!this.webhookUrl) {
      const message = "WEBHOOK_URL is not configured";
      this.logger.warn(`[webhook] ${message}`);
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }
    if (!this.webhookSecret) {
      const message = "WEBHOOK_SECRET is not configured";
      this.logger.warn(`[webhook] ${message}`);
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }

    // Same breaker check as `sendTransactionEvent`; see the comment there.
    const circuit = this.circuitBlocksDelivery();
    if (circuit === "open") {
      const message = "Circuit breaker is open for this webhook destination";
      this.logger.warn(
        `[webhook] flat delivery suppressed event=${event} transactionId=${transaction.id}: ${message}`,
      );
      webhookCircuitBreakerSkippedTotal.inc({ event_type: event });
      return {
        status: "skipped",
        attempts: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: message,
      };
    }

    const payload = this.buildFlatPayload(event, transaction);
    const validation = flatWebhookPayloadSchema.safeParse(payload);
    if (!validation.success) {
      this.logger.warn(`[webhook] flat payload validation failed: ${validation.error}`);
      return { status: "failed", attempts: 0, lastAttemptAt: null, deliveredAt: null, lastError: "Payload validation failed" };
    }
    const rawPayload = JSON.stringify(payload);
    const signature = this.signPayload(rawPayload);
    const { body, extraHeaders } = await prepareBody(rawPayload, this.compress);

    let lastError: string | null = null;
    let lastStatusCode: number | undefined;
    let lastAttemptAt: Date | null = null;
    let finalAttempt = 0;
    const deliveryStart = Date.now();

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      lastAttemptAt = this.now();
      finalAttempt = attempt;
      try {
        const response = await this.fetchImpl(this.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            ...extraHeaders,
          },
          body: body as any,
        });
        lastStatusCode = response.status;
        if (!response.ok)
          throw new Error(`Webhook responded with HTTP ${response.status}`);
        this.logger.log(
          `[webhook] delivered flat event=${event} transactionId=${payload.transaction_id} attempt=${attempt} compressed=${this.compress}`,
        );

        const durationSecs = (Date.now() - deliveryStart) / 1000;
        webhookDeliveryDurationSeconds.observe({ event_type: event, status: "delivered" }, durationSecs);
        if (attempt > 1) {
          webhookDeliveryRetriesTotal.inc({ event_type: event, final_status: "delivered" });
        }

        this.circuitBreaker.recordSuccess(this.webhookUrl);

        return {
          status: "delivered",
          attempts: attempt,
          statusCode: response.status,
          lastAttemptAt,
          deliveredAt: lastAttemptAt,
          lastError: null,
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : "Unknown webhook error";
        this.logger.warn(
          `[webhook] delivery failed flat event=${event} transactionId=${payload.transaction_id} attempt=${attempt}/${this.maxAttempts}: ${lastError}`,
        );

        webhookRetryAttemptsTotal.inc({
          event_type: event,
          attempt: String(attempt),
          status_code: String(lastStatusCode || 0),
        });

        // Check if we should retry based on error type
        if (attempt < this.maxAttempts && isRetryableError(error, lastStatusCode)) {
          const delayMs = calculateBackoffDelay(
            this.baseDelayMs,
            attempt,
            this.maxDelayMs,
            this.jitterFactor,
          );
          webhookBackoffDelaySeconds.observe({ event_type: event, attempt: String(attempt) }, delayMs / 1000);
          this.logger.log(
            `[webhook] retrying in ${delayMs}ms flat event=${event} transactionId=${payload.transaction_id} attempt=${attempt + 1}/${this.maxAttempts}`,
          );
          await this.sleepImpl(delayMs);
        } else if (attempt < this.maxAttempts) {
          // Non-retryable error, break early
          this.logger.warn(
            `[webhook] non-retryable error, stopping retries flat event=${event} transactionId=${payload.transaction_id}: ${lastError}`,
          );
          break;
        }
      }
    }

    this.logger.error(
      `[webhook] delivery exhausted flat event=${event} transactionId=${payload.transaction_id}: ${lastError}`,
    );

    const durationSecs = (Date.now() - deliveryStart) / 1000;
    webhookDeliveryDurationSeconds.observe({ event_type: event, status: "failed" }, durationSecs);
    webhookDeliveryRetriesTotal.inc({ event_type: event, final_status: "failed" });
    this.onDeliveryFailure(lastError);

    this.circuitBreaker.recordFailure(this.webhookUrl, lastError, circuit === "probe");

    return {
      status: "failed",
      attempts: finalAttempt,
      statusCode: lastStatusCode,
      lastAttemptAt,
      deliveredAt: null,
      lastError,
    };
  }

  /**
   * Processes pending outbox entries with explicit consumer acknowledgment
   * tracking (#630).
   *
   * Delivery guarantee flow per entry:
   *  1. Mark the entry as "processing" and record an `ackDeadlineAt` timestamp.
   *  2. POST the payload to the webhook endpoint.
   *  3. Only mark the entry as "delivered" when the endpoint responds with a
   *     2xx status — this is the explicit ACK.  Any other response (non-2xx,
   *     network error, timeout) is treated as an unconfirmed delivery.
   *  4. On failure: if `attempts < maxAttempts`, re-queue with exponential
   *     backoff (status → "pending").  On final exhaustion, move the entry to
   *     the DLQ via `outboxModel.moveToDLQ()` if available, otherwise mark as
   *     "failed".
   *
   * The caller (scheduler) should also periodically call processOutbox() to
   * re-pick any entries that have been stuck in "processing" past their
   * `ackDeadlineAt` (e.g. due to a crashed worker between steps 2 and 3).
   * Those entries are re-queued back to "pending" automatically.
   */
  async processOutbox(
    outboxModel: WebhookOutboxModel,
    batchSize: number = 10,
  ): Promise<{ processed: number; failures: number }> {
    const entries = await outboxModel.findNextToProcess(batchSize);
    let processed = 0;
    let failures = 0;

    // Issue #573: skip the whole batch while the circuit is open.
    if (this.circuitGate()) {
      return { processed: 0, failures: 0 };
    }

    for (const entry of entries) {
      const now = this.now();

      // ── Re-queue entries stuck in "processing" past their ACK deadline ──
      // This handles crashed workers that posted the payload but never updated
      // the status.  The entry gets treated as a new attempt so delivery is
      // retried automatically.
      if (
        entry.status === "processing" &&
        entry.ackDeadlineAt &&
        now > entry.ackDeadlineAt
      ) {
        const attempts = entry.attempts + 1;
        if (attempts >= entry.maxAttempts) {
          this.logger.error(
            `[webhook-outbox] ACK timeout exhausted retries entry=${entry.id}`,
          );
          if (outboxModel.moveToDLQ) {
            await outboxModel.moveToDLQ(entry.id, `ACK timeout after ${attempts} attempts`);
          } else {
            await outboxModel.update(entry.id, {
              status: "failed",
              attempts,
              lastAttemptAt: now,
              errorMessage: `ACK timeout after ${attempts} attempts`,
            });
          }
          failures++;
        } else {
          const delayMs = calculateBackoffDelay(
            this.baseDelayMs,
            attempts,
            this.maxDelayMs,
            this.jitterFactor,
          );
          await outboxModel.update(entry.id, {
            status: "pending",
            attempts,
            lastAttemptAt: now,
            nextAttemptAt: new Date(now.getTime() + delayMs),
            ackDeadlineAt: undefined,
            errorMessage: `ACK timeout — re-queued (attempt ${attempts}/${entry.maxAttempts})`,
          });
          this.logger.warn(
            `[webhook-outbox] ACK timeout for entry=${entry.id} — re-queuing, attempt ${attempts}/${entry.maxAttempts}`,
          );
          failures++;
        }
        continue;
      }

      // ── Mark as "processing" with an ACK deadline before sending ────────
      const ackDeadlineAt = new Date(now.getTime() + this.ackTimeoutMs);
      await outboxModel.update(entry.id, {
        status: "processing",
        ackDeadlineAt,
      });

      const rawPayload = JSON.stringify(entry.payload);
      const signature = this.signPayload(rawPayload);
      const useCompress = entry.compress ?? this.compress;
      const { body, extraHeaders } = await prepareBody(rawPayload, useCompress);

      try {
        const response = await this.fetchImpl(this.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            ...extraHeaders,
          },
          body: body as any,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        // Explicit ACK received (2xx response) — mark as delivered.
        this.logger.log(
          `[webhook-outbox] ACK received — delivered entry=${entry.id} compressed=${useCompress}`,
        );
        await outboxModel.update(entry.id, {
          status: "delivered",
          attempts: entry.attempts + 1,
          lastAttemptAt: now,
          ackDeadlineAt: undefined,
          errorMessage: undefined,
        });
        processed++;
      } catch (error) {
        failures++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const attempts = entry.attempts + 1;

        if (attempts >= entry.maxAttempts) {
          // Final attempt exhausted — move to DLQ
          this.logger.error(
            `[webhook-outbox] Exhausted retries entry=${entry.id}: ${errorMessage}`,
          );
          if (outboxModel.moveToDLQ) {
            await outboxModel.moveToDLQ(entry.id, `Exhausted retries: ${errorMessage}`);
          } else {
            await outboxModel.update(entry.id, {
              status: "failed",
              attempts,
              lastAttemptAt: now,
              ackDeadlineAt: undefined,
              errorMessage: `Exhausted retries: ${errorMessage}`,
            });
          }
        } else {
          // Re-queue with backoff
          const delayMs = calculateBackoffDelay(
            this.baseDelayMs,
            attempts,
            this.maxDelayMs,
            this.jitterFactor,
          );
          await outboxModel.update(entry.id, {
            status: "pending",
            attempts,
            lastAttemptAt: now,
            nextAttemptAt: new Date(now.getTime() + delayMs),
            ackDeadlineAt: undefined,
            errorMessage,
          });
          this.logger.log(
            `[webhook-outbox] retrying in ${delayMs}ms entry=${entry.id} attempt=${attempts + 1}/${entry.maxAttempts}`,
          );
        }

        this.logger.warn(
          `[webhook-outbox] Failed to deliver entry=${entry.id} attempt=${attempts}/${entry.maxAttempts}: ${errorMessage}`,
        );
      }
    }

    return { processed, failures };
  }
}

export async function notifyTransactionWebhook(
  transactionId: string,
  event: WebhookEvent,
  dependencies: {
    transactionModel: WebhookTransactionModel;
    webhookService?: WebhookService;
    logger?: WebhookLogger;
  },
): Promise<WebhookDeliveryResult | null> {
  const webhookService = dependencies.webhookService ?? new WebhookService();
  const logger = dependencies.logger ?? console;
  const transaction =
    await dependencies.transactionModel.findById(transactionId);
  if (!transaction) {
    logger.warn(
      `[webhook] skipped event=${event} transactionId=${transactionId}: transaction not found`,
    );
    return null;
  }
  const result = await webhookService.sendTransactionEvent(event, transaction);

  // Guard clause added here
  if (
    typeof dependencies.transactionModel.updateWebhookDelivery === "function"
  ) {
    await dependencies.transactionModel.updateWebhookDelivery(transactionId, {
      status: result.status,
      lastAttemptAt: result.lastAttemptAt,
      deliveredAt: result.deliveredAt,
      lastError: result.lastError ?? null,
    });
  }
  return result;
}

export async function enqueueTransactionWebhook(
  transactionId: string,
  event: WebhookEvent,
  dependencies: {
    transactionModel: WebhookTransactionModel;
    outboxModel: WebhookOutboxModel;
    webhookService?: WebhookService;
    useFlatPayload?: boolean;
    compress?: boolean;
  },
): Promise<string | null> {
  const webhookService = dependencies.webhookService ?? new WebhookService();
  const transaction =
    await dependencies.transactionModel.findById(transactionId);
  if (!transaction) return null;
  const payload = dependencies.useFlatPayload
    ? webhookService.buildFlatPayload(event, transaction)
    : webhookService.buildPayload(event, transaction);
  return dependencies.outboxModel.insert({
    eventType: event,
    payload,
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
    compress: dependencies.compress ?? webhookService.compress,
  });
}

export async function notifyFlatTransactionWebhook(
  transactionId: string,
  event: WebhookEvent,
  dependencies: {
    transactionModel: WebhookTransactionModel;
    webhookService?: WebhookService;
    logger?: WebhookLogger;
  },
): Promise<WebhookDeliveryResult | null> {
  const webhookService = dependencies.webhookService ?? new WebhookService();
  const logger = dependencies.logger ?? console;
  const transaction =
    await dependencies.transactionModel.findById(transactionId);
  if (!transaction) {
    logger.warn(
      `[webhook] skipped flat event=${event} transactionId=${transactionId}: transaction not found`,
    );
    return null;
  }
  const result = await webhookService.sendFlatTransactionEvent(
    event,
    transaction,
  );

  // Guard clause added here
  if (
    typeof dependencies.transactionModel.updateWebhookDelivery === "function"
  ) {
    await dependencies.transactionModel.updateWebhookDelivery(transactionId, {
      status: result.status,
      lastAttemptAt: result.lastAttemptAt,
      deliveredAt: result.deliveredAt,
      lastError: result.lastError ?? null,
    });
  }
  return result;
}
