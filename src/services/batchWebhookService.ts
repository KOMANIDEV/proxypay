import axios from "axios";
import {
  BatchOperationModel,
  BatchItemModel,
  BatchOperationStatus,
  WebhookStatus,
} from "../models/batchOperation";

const batchOperationModel = new BatchOperationModel();
const batchItemModel = new BatchItemModel();

interface BatchWebhookPayload {
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
  event_type?: string;
  processedCount?: number;
  percentageComplete?: number;
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

export class BatchWebhookService {
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

  /**
   * Send an intermediate progress webhook for a batch operation.
   * Called periodically during processing to report progress to the webhook consumer.
   *
   * @param batchOperationId  UUID of the batch operation.
   * @param processedCount    Number of items processed so far.
   * @param totalCount        Total number of items in the batch.
   */
  async sendBatchIntermediateProgressWebhook(
    batchOperationId: string,
    processedCount: number,
    totalCount: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const operation = await batchOperationModel.findById(batchOperationId);
      if (!operation || !operation.webhookUrl) {
        return { success: true }; // No webhook configured, consider it successful
      }

      const percentageComplete = totalCount > 0
        ? Math.round((processedCount / totalCount) * 100)
        : 0;

      const payload: BatchWebhookPayload = {
        batchReference: operation.batchReference,
        batchId: operation.id,
        status: operation.status,
        provider: operation.provider,
        operationType: operation.operationType,
        totalItems: operation.totalItems,
        completedItems: operation.completedItems,
        failedItems: operation.failedItems,
        pendingItems: totalCount - processedCount,
        timestamp: new Date().toISOString(),
        event_type: 'batch_progress',
        processedCount,
        percentageComplete,
      };

      await this.sendWebhookWithRetry(operation.webhookUrl, payload);

      return { success: true };
    } catch (error) {
      return { success: false, error: "Webhook failed after retries" };
    }
  }

  /**
   * Send batch operation progress webhook
   */
  async sendBatchProgressWebhook(
    batchOperationId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const operation = await batchOperationModel.findById(batchOperationId);
      if (!operation || !operation.webhookUrl) {
        return { success: true }; // No webhook configured, consider it successful
      }

      const summary = await batchItemModel.getBatchSummary(batchOperationId);

      const payload: BatchWebhookPayload = {
        batchReference: operation.batchReference,
        batchId: operation.id,
        status: operation.status,
        provider: operation.provider,
        operationType: operation.operationType,
        totalItems: operation.totalItems,
        completedItems: operation.completedItems,
        failedItems: operation.failedItems,
        pendingItems: summary.pending,
        timestamp: new Date().toISOString(),
      };

      await this.sendWebhookWithRetry(operation.webhookUrl, payload);

      // Update webhook status in database
      await batchOperationModel.updateWebhookStatus(
        batchOperationId,
        WebhookStatus.Sent,
      );

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      // Update webhook status with error
      await batchOperationModel.updateWebhookStatus(
        batchOperationId,
        WebhookStatus.Failed,
        errorMessage,
      );

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
   */
  async sendBatchCompletionWebhook(
    batchOperationId: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.sendBatchProgressWebhook(batchOperationId);
  }

  /**
   * Send batch failure webhook
   */
  async sendBatchFailureWebhook(
    batchOperationId: string,
    error: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const operation = await batchOperationModel.findById(batchOperationId);
      if (!operation || !operation.webhookUrl) {
        return { success: true };
      }

      const summary = await batchItemModel.getBatchSummary(batchOperationId);

      const payload: BatchWebhookPayload & { error?: string } = {
        batchReference: operation.batchReference,
        batchId: operation.id,
        status: operation.status,
        provider: operation.provider,
        operationType: operation.operationType,
        totalItems: operation.totalItems,
        completedItems: operation.completedItems,
        failedItems: operation.failedItems,
        pendingItems: summary.pending,
        timestamp: new Date().toISOString(),
        error,
      };

      await this.sendWebhookWithRetry(operation.webhookUrl, payload);

      await batchOperationModel.updateWebhookStatus(
        batchOperationId,
        WebhookStatus.Sent,
      );

      return { success: true };
    } catch (webhookError) {
      const errorMessage = webhookError instanceof Error ? webhookError.message : "Unknown error";
      
      await batchOperationModel.updateWebhookStatus(
        batchOperationId,
        WebhookStatus.Failed,
        errorMessage,
      );

      return { success: false, error: errorMessage };
    }
  }
}

export const batchWebhookService = new BatchWebhookService();
