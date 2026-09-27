import { createHmac, timingSafeEqual } from "crypto";
import {
  MerchantWebhookModel,
  MerchantWebhook,
  WebhookDeliveryLog,
} from "../models/merchantWebhook";
import { capturePersistentFailure } from "../queue/dlq";
import { SAMPLE_WEBHOOK_PAYLOAD } from "../routes/webhooks";
import {
  checkWebhookRateLimit,
  recordWebhookFailure,
  recordWebhookSuccess,
} from "./webhookRateLimiter";

const model = new MerchantWebhookModel();

const DEFAULT_TIMEOUT_MS = 10_000;

// Retry configuration defaults
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_JITTER_FACTOR = 0.2;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

// Retryable status codes (429 = rate limited, 5xx = server errors)
const DEFAULT_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

interface DeliveryResult {
  status: "delivered" | "failed";
  httpStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  durationMs: number;
  attempts: number;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Webhook Signature Algorithm Documentation (HMAC-SHA256)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Algorithm:
 * - HMAC (Hash-based Message Authentication Code) with SHA-256 hash function.
 *
 * Header format:
 * - Delivered in `X-Webhook-Signature` and `X-Signature` HTTP request headers.
 * - Format: `sha256=<hex_digest>`
 *   Where `<hex_digest>` is the 64-character lowercase hex string computed by
 *   HMAC-SHA256(secret, raw_payload_body).
 *
 * Verification procedure for webhook consumers:
 * 1. Extract the raw HTTP request body string or buffer BEFORE JSON parsing.
 * 2. Retrieve the signature from the `X-Webhook-Signature` or `X-Signature` header.
 * 3. Compute HMAC-SHA256 using the shared merchant secret and the raw request body.
 * 4. Compare the expected digest with the received digest using a constant-time /
 *    timing-safe equality check (e.g. `crypto.timingSafeEqual` in Node.js,
 *    `hmac.compare_digest` in Python) to prevent timing attacks.
 *
 * @param payload - Verbatim raw payload string (do not re-serialize JSON)
 * @param secret - The shared webhook secret key
 * @returns Prefixed hex signature `sha256=<hex>`
 */
export function signPayload(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Validates an incoming webhook signature received from ProxyPay.
 *
 * @example
 * ```ts
 * const isValid = verifyWebhookSignature(req.rawBody, process.env.WEBHOOK_SECRET, req.headers["x-webhook-signature"]);
 * if (!isValid) {
 *   return res.status(401).send("Invalid signature");
 * }
 * ```
 *
 * @param rawBody - Raw body buffer or UTF-8 string
 * @param secret - Shared merchant webhook secret key
 * @param signatureHeader - Header value from `X-Webhook-Signature` or `X-Signature`
 * @returns boolean indicating whether the signature is authentic
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  secret: string,
  signatureHeader?: string | string[],
): boolean {
  if (!rawBody || !secret || !signatureHeader) {
    return false;
  }

  const rawHeader = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!rawHeader) return false;

  const expectedSignature = signPayload(
    typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"),
    secret,
  );

  const cleanExpected = expectedSignature.replace(/^sha256=/, "").trim();
  const cleanReceived = rawHeader.replace(/^sha256=/, "").trim();

  if (cleanExpected.length !== cleanReceived.length) {
    return false;
  }

  try {
    const expectedBuf = Buffer.from(cleanExpected, "hex");
    const receivedBuf = Buffer.from(cleanReceived, "hex");
    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

/**
 * Calculate exponential backoff delay with jitter and max cap.
 * @param baseDelayMs - Base delay in milliseconds
 * @param attempt - Current attempt number (0-indexed)
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @param jitterFactor - Jitter factor (0-1) to add randomness
 * @param backoffMultiplier - Multiplier for exponential backoff
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs: number,
  jitterFactor: number,
  backoffMultiplier: number,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(backoffMultiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitter = cappedDelay * jitterFactor * Math.random();
  return Math.floor(cappedDelay + jitter);
}

/**
 * Determine if an error is retryable.
 * Retry on: network errors, timeouts, 429 (rate limited), 5xx server errors
 * Don't retry on: 4xx client errors (except 429)
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

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deliver a single webhook payload to the given URL with exponential backoff retry.
 * Returns a structured result regardless of success/failure.
 */
async function deliverWithRetry(
  url: string,
  secret: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterFactor?: number;
    backoffMultiplier?: number;
    retryableStatusCodes?: number[];
    dlq?: {
      originalJobId?: string;
      queueName?: string;
      jobName?: string;
      userId?: string;
      webhookId?: string;
      eventType?: string;
    };
  } = {},
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, secret);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterFactor = options.jitterFactor ?? DEFAULT_JITTER_FACTOR;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const retryableStatusCodes = options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
  const dlqContext = options.dlq ?? {};

  let lastError: string | null = null;
  let lastStatusCode: number | undefined;
  let totalDurationMs = 0;

  const finalizeFailure = async (
    errorMessage: string,
    statusCode?: number,
    attemptsMade = maxAttempts,
    durationMs = totalDurationMs,
  ): Promise<DeliveryResult> => {
    const finalFailureReason = errorMessage || `Webhook delivery failed after ${maxAttempts} attempts`;

    await Promise.resolve(
      capturePersistentFailure({
        originalJobId: dlqContext.originalJobId ?? url,
        queueName: dlqContext.queueName ?? "merchant-webhooks",
        jobName: dlqContext.jobName ?? "deliver-webhook",
        jobData: {
          url,
          webhookId: dlqContext.webhookId,
          userId: dlqContext.userId,
          eventType: dlqContext.eventType,
          payload,
          attemptsMade,
          lastStatusCode: statusCode,
          errorMessage: finalFailureReason,
        },
        failureReason: finalFailureReason,
        attemptsMade,
      }),
    ).catch((err) => {
      console.warn("[MerchantWebhookService] failed to persist webhook delivery to DLQ", err);
    });

    return {
      status: "failed",
      httpStatus: statusCode,
      errorMessage: finalFailureReason,
      durationMs,
      attempts: attemptsMade,
    };
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            "X-Signature": signature,
            "User-Agent": "MobileMoney-Webhook/1.0",
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Date.now() - start;
      totalDurationMs += durationMs;
      const responseBody = await response.text().catch(() => "");

      if (response.ok) {
        return {
          status: "delivered",
          httpStatus: response.status,
          responseBody,
          errorMessage: null,
          durationMs: totalDurationMs,
          attempts: attempt + 1,
        };
      }

      lastStatusCode = response.status;
      lastError = `HTTP ${response.status}`;

      // Check if we should retry
      const isRetryable = retryableStatusCodes.includes(response.status);
      if (attempt < maxAttempts - 1 && isRetryable) {
        const delayMs = calculateBackoffDelay(
          baseDelayMs,
          attempt,
          maxDelayMs,
          jitterFactor,
          backoffMultiplier,
        );
        console.log(
          `[MerchantWebhookService] retrying in ${delayMs}ms for URL ${url} attempt=${attempt + 2}/${maxAttempts}`,
        );
        await sleep(delayMs);
        continue;
      }

      return await finalizeFailure(
        lastError ?? `HTTP ${response.status}`,
        response.status,
        attempt + 1,
        totalDurationMs,
      );
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      totalDurationMs += durationMs;
      const errorMessage =
        err instanceof Error
          ? err.name === "AbortError"
            ? `Timeout after ${DEFAULT_TIMEOUT_MS}ms`
            : err.message
          : String(err);
      lastError = errorMessage;

      // Check if we should retry (network errors are retryable)
      if (attempt < maxAttempts - 1 && isRetryableError(err, undefined)) {
        const delayMs = calculateBackoffDelay(
          baseDelayMs,
          attempt,
          maxDelayMs,
          jitterFactor,
          backoffMultiplier,
        );
        console.log(
          `[MerchantWebhookService] retrying in ${delayMs}ms for URL ${url} attempt=${attempt + 2}/${maxAttempts}: ${errorMessage}`,
        );
        await sleep(delayMs);
        continue;
      }

      return await finalizeFailure(
        errorMessage,
        undefined,
        attempt + 1,
        totalDurationMs,
      );
    }
  }

  return await finalizeFailure(
    lastError ?? `Webhook delivery failed after ${maxAttempts} attempts`,
    lastStatusCode,
    maxAttempts,
    totalDurationMs,
  );
}

export interface MerchantWebhookServiceOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
}

export class MerchantWebhookService {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterFactor: number;
  private readonly backoffMultiplier: number;
  private readonly retryableStatusCodes: number[];

  constructor(options: MerchantWebhookServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.jitterFactor = options.jitterFactor ?? DEFAULT_JITTER_FACTOR;
    this.backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    this.retryableStatusCodes = options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
  }

  /**
   * Send a test delivery using the canonical sample payload.
   * Records the attempt in webhook_delivery_logs with is_test=true.
   */
  async testWebhook(
    webhookId: string,
    userId: string,
  ): Promise<{ log: WebhookDeliveryLog; webhook: MerchantWebhook }> {
    const webhook = await model.findById(webhookId, userId);
    if (!webhook) throw new Error("Webhook not found");

    const rateLimitResult = await checkWebhookRateLimit(userId);
    if (!rateLimitResult.allowed) {
      throw new Error(
        `Rate limit exceeded. Retry after ${rateLimitResult.retryAfterSecs ?? 1} second(s).`,
      );
    }

    const payload = {
      ...SAMPLE_WEBHOOK_PAYLOAD,
      timestamp: new Date().toISOString(),
    };

    const result = await deliverWithRetry(
      webhook.url,
      webhook.secret,
      payload,
      this.fetchImpl,
      {
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs,
        maxDelayMs: this.maxDelayMs,
        jitterFactor: this.jitterFactor,
        backoffMultiplier: this.backoffMultiplier,
        retryableStatusCodes: this.retryableStatusCodes,
        dlq: {
          originalJobId: webhook.id,
          queueName: "merchant-webhooks",
          jobName: "deliver-webhook",
          userId,
          webhookId: webhook.id,
          eventType: "transaction.completed",
        },
      },
    );

    if (result.status === "delivered") {
      await recordWebhookSuccess(userId);
    } else {
      await recordWebhookFailure(userId);
    }

    const log = await model.insertDeliveryLog({
      webhookId: webhook.id,
      eventType: "transaction.completed",
      payload,
      status: result.status,
      httpStatus: result.httpStatus,
      responseBody: result.responseBody,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      isTest: true,
    });

    return { log, webhook };
  }

  /**
   * Deliver a real event to all active webhooks for a user that subscribe to the event.
   * Called by the transaction worker after status changes.
   */
  async dispatchEvent(
    userId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const rateLimitResult = await checkWebhookRateLimit(userId);
    if (!rateLimitResult.allowed) {
      console.warn(
        `[MerchantWebhookService] Rate limit exceeded for merchant ${userId}. ` +
          `Retry after ${rateLimitResult.retryAfterSecs ?? 1}s. isAdaptive=${rateLimitResult.isAdaptive}`,
      );
      return;
    }

    const webhooks = await model.findByUserId(userId);
    const active = webhooks.filter((w) => w.isActive && w.events.includes(eventType));

    await Promise.allSettled(
      active.map(async (webhook) => {
        const result = await deliverWithRetry(
          webhook.url,
          webhook.secret,
          payload,
          this.fetchImpl,
          {
            maxAttempts: this.maxAttempts,
            baseDelayMs: this.baseDelayMs,
            maxDelayMs: this.maxDelayMs,
            jitterFactor: this.jitterFactor,
            backoffMultiplier: this.backoffMultiplier,
            retryableStatusCodes: this.retryableStatusCodes,
            dlq: {
              originalJobId: webhook.id,
              queueName: "merchant-webhooks",
              jobName: "deliver-webhook",
              userId,
              webhookId: webhook.id,
              eventType,
            },
          },
        );

        if (result.status === "delivered") {
          await recordWebhookSuccess(userId);
        } else {
          await recordWebhookFailure(userId);
        }

        await model.insertDeliveryLog({
          webhookId: webhook.id,
          eventType,
          payload,
          status: result.status,
          httpStatus: result.httpStatus,
          responseBody: result.responseBody,
          errorMessage: result.errorMessage,
          durationMs: result.durationMs,
          isTest: false,
        });
      }),
    );
  }
}

export const merchantWebhookService = new MerchantWebhookService();
export { model as merchantWebhookModel };

// Export utility functions for testing and consumer validation
export {
  deliverWithRetry,
  calculateBackoffDelay,
  isRetryableError,
  sleep,
  signPayload,
  verifyWebhookSignature,
};
