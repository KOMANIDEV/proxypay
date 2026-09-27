import axios from "axios";
import {
  BatchOperationModel,
  BatchItemModel,
  BatchOperationStatus,
  WebhookStatus,
} from "../models/batchOperation";

const batchOperationModel = new BatchOperationModel();
const batchItemModel = new BatchItemModel();

/**
 * Batch operation events emitted to merchant webhooks (Issue #626).
 * Merchants opt in per-webhook through the `events` field / `BATCH_WEBHOOK_EVENTS`.
 */
export type BatchWebhookEvent =
  | "batch_started"
  | "batch_completed"
  | "batch_failed";

export const BATCH_WEBHOOK_EVENTS: BatchWebhookEvent[] = [
  "batch_started",
  "batch_completed",
  "batch_failed",
];

interface BatchWebhookPayload {
  event: BatchWebhookEvent;
  batchReference: string;
  batchId: string;
  status: BatchOperationStatus;
  provider: string;
  operationType: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  pendingItems: number;
  timestamp: string;
  /** Present on `batch_completed` — rolled-up batch outcome. */
  summary?: BatchWebhookSummary;
  /** Present on `batch_failed` — error details. */
  error?: string;
}

export interface BatchWebhookSummary {
  totalItems: number;
  completedItems: number;
  failedItems: number;
  pendingItems: number;
  successRate: number;
  durationMs: number | null;
}

interface BatchItemWebhookPayload {
  batchReference: string;
  batchId: string;
  itemId: string;
  referenceId: string;
  status: string;
  errorMessage?: string;
  retryCount: number;
  timestamp: string;
}

/**
 * Resolve the batch events this service is allowed to deliver. When
 * `BATCH_WEBHOOK_EVENTS` is unset every batch event is enabled; when it is set
 * it acts as a comma-separated allow-list (e.g. `batch_completed,batch_failed`).
 */
export function resolveEnabledBatchEvents(
  configured: string | undefined = process.env.BATCH_WEBHOOK_EVENTS,
): BatchWebhookEvent[] {
  if (configured === undefined || configured.trim() === "") {
    return [...BATCH_WEBHOOK_EVENTS];
  }
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is BatchWebhookEvent =>
      (BATCH_WEBHOOK_EVENTS as string[]).includes(value),
    );
}

export class BatchWebhookService {
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;
  /** Batch events this instance is allowed to deliver (Issue #626 filter). */
  readonly enabledEvents: BatchWebhookEvent[];

  constructor(options: { enabledEvents?: BatchWebhookEvent[] } = {}) {
    this.enabledEvents = options.enabledEvents ?? resolveEnabledBatchEvents();
  }

  /** Whether `event` passes the configured batch event filter. */
  isEventEnabled(event: BatchWebhookEvent): boolean {
    return this.enabledEvents.includes(event);
  }

  /**
   * Send batch operation progress webhook.
   *
   * @deprecated use {@link sendBatchCompletedWebhook} (kept for callers that
   * relied on the historic "progress" naming).
   */
  async sendBatchProgressWebhook(
    batchOperationId: string,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    return this.sendBatchCompletedWebhook(batchOperationId);
  }

  /**
   * Notify merchants that a batch operation has started (Issue #626).
   */
  async sendBatchStartedWebhook(
    batchOperationId: string,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    return this.deliverBatchEvent(batchOperationId, "batch_started");
  }

  /**
   * Notify merchants that a batch operation completed, including a summary of
   * the outcome (Issue #626).
   */
  async sendBatchCompletedWebhook(
    batchOperationId: string,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    return this.deliverBatchEvent(batchOperationId, "batch_completed");
  }

  /**
   * Notify merchants that a batch operation failed, including error details
   * (Issue #626).
   */
  async sendBatchFailedWebhook(
    batchOperationId: string,
    error: string,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    return this.deliverBatchEvent(batchOperationId, "batch_failed", error);
  }

  /**
   * Build and deliver a single batch lifecycle event. Respects the batch event
   * filter and records the webhook status against the batch operation.
   */
  private async deliverBatchEvent(
    batchOperationId: string,
    event: BatchWebhookEvent,
    error?: string,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    if (!this.isEventEnabled(event)) {
      console.log(
        `[BatchWebhookService] skipping ${event} for batch ${batchOperationId}: event disabled by filter`,
      );
      return { success: true, skipped: true };
    }

    try {
      const operation = await batchOperationModel.findById(batchOperationId);
      if (!operation || !operation.webhookUrl) {
        return { success: true, skipped: true }; // No webhook configured
      }

      const itemSummary = await batchItemModel.getBatchSummary(batchOperationId);
      const pendingItems = itemSummary?.pending ?? 0;

      const payload: BatchWebhookPayload = {
        event,
        batchReference: operation.batchReference,
        batchId: operation.id,
        status: operation.status,
        provider: operation.provider,
        operationType: operation.operationType,
        totalItems: operation.totalItems,
        completedItems: operation.completedItems,
        failedItems: operation.failedItems,
        pendingItems,
        timestamp: new Date().toISOString(),
      };

      if (event === "batch_completed") {
        payload.summary = {
          totalItems: operation.totalItems,
          completedItems: operation.completedItems,
          failedItems: operation.failedItems,
          pendingItems,
          successRate:
            operation.totalItems > 0
              ? Number(
                  (operation.completedItems / operation.totalItems).toFixed(4),
                )
              : 0,
          durationMs: operation.completedAt
            ? operation.completedAt.getTime() - operation.startedAt.getTime()
            : null,
        };
      }

      if (event === "batch_failed") {
        payload.error = error ?? "Batch operation failed";
      }

      await this.sendWebhookWithRetry(operation.webhookUrl, payload);

      // Update webhook status in database
      await batchOperationModel.updateWebhookStatus(
        batchOperationId,
        WebhookStatus.Sent,
      );

      return { success: true };
    } catch (webhookError) {
      const errorMessage =
        webhookError instanceof Error ? webhookError.message : "Unknown error";

      await batchOperationModel
        .updateWebhookStatus(batchOperationId, WebhookStatus.Failed, errorMessage)
        .catch(() => undefined);

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send batch item status webhook
   */
  async sendBatchItemWebhook(
    batchItemId: string,
    webhookUrl: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const item = await batchItemModel.findById(batchItemId);
      if (!item) {
        return { success: false, error: "Batch item not found" };
      }

      const operation = await batchOperationModel.findById(item.batchId);
      if (!operation) {
        return { success: false, error: "Batch operation not found" };
      }

      const payload: BatchItemWebhookPayload = {
        batchReference: operation.batchReference,
        batchId: operation.id,
        itemId: item.id,
        referenceId: item.referenceId,
        status: item.status,
        errorMessage: item.errorMessage || undefined,
        retryCount: item.retryCount,
        timestamp: new Date().toISOString(),
      };

      await this.sendWebhookWithRetry(webhookUrl, payload);

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send webhook with retry logic
   */
  private async sendWebhookWithRetry(
    url: string,
    payload: BatchWebhookPayload | BatchItemWebhookPayload,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await axios.post(url, payload, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "ProxyPay-BatchWebhook/1.0",
          },
          timeout: 10000, // 10 second timeout
        });

        if (response.status >= 200 && response.status < 300) {
          return; // Success
        }

        lastError = new Error(
          `Webhook returned status ${response.status}`,
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Unknown webhook error");
        
        if (attempt < this.maxRetries - 1) {
          // Exponential backoff
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error("Webhook failed after retries");
  }

  /**
   * Send batch completion webhook
   * @deprecated use {@link sendBatchCompletedWebhook}
   */
  async sendBatchCompletionWebhook(
    batchOperationId: string,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    return this.sendBatchCompletedWebhook(batchOperationId);
  }

  /**
   * Send batch failure webhook
   * @deprecated use {@link sendBatchFailedWebhook}
   */
  async sendBatchFailureWebhook(
    batchOperationId: string,
    error: string,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    return this.sendBatchFailedWebhook(batchOperationId, error);
  }
}

export const batchWebhookService = new BatchWebhookService();
