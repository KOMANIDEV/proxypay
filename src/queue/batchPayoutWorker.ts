import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService, BatchPayoutItem, BatchPayoutResult } from "../services/mobilemoney/mobileMoneyService";
import { rabbitMQManager, EXCHANGES, ROUTING_KEYS } from "./rabbitmq";
import { EmailService } from "../services/email";
import { UserModel } from "../models/users";
import { SmsService } from "../services/sms";
import { notifyTransactionWebhook, WebhookService } from "../services/webhook";
import { pushNotificationService } from "../services/push";
import {
  batchPayoutTotal,
  batchPayoutItemsTotal,
  batchPayoutDurationSeconds,
  batchPayoutSize,
} from "../utils/metrics";
import { ParallelBatchProcessor, BatchItem } from "../services/parallelBatchProcessor";
import {
  BatchOperationModel,
  BatchItemModel,
  BatchOperationStatus,
  BatchItemStatus,
} from "../models/batchOperation";
import { v4 as uuidv4 } from "uuid";
import { batchWebhookService } from "../services/batchWebhookService";

const transactionModel = new TransactionModel();
const mobileMoneyService = new MobileMoneyService();
const emailService = new EmailService();
const userModel = new UserModel();
const smsService = new SmsService();
const webhookService = new WebhookService();
const pushService = pushNotificationService;
const batchOperationModel = new BatchOperationModel();
const batchItemModel = new BatchItemModel();

const BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_PAYOUT_INTERVAL_MS || "5000", 10);
const SUPPORTED_PROVIDERS = ["mtn"];
const PARALLEL_CONCURRENCY = parseInt(process.env.BATCH_PAYOUT_CONCURRENCY || "5", 10);
const RATE_LIMIT_PER_SECOND = parseInt(process.env.BATCH_PAYOUT_RATE_LIMIT || "50", 10);
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.BATCH_PAYOUT_CB_THRESHOLD || "10", 10);
const CIRCUIT_BREAKER_RESET_MS = parseInt(process.env.BATCH_PAYOUT_CB_RESET_MS || "60000", 10);
const PROGRESS_WEBHOOK_INTERVAL = parseInt(process.env.BATCH_PROGRESS_WEBHOOK_INTERVAL || "100", 10);

interface PendingPayout {
  transactionId: string;
  phoneNumber: string;
  amount: string;
  provider: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function sendTransactionEmail(transactionId: string): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  if (!transaction?.userId) return;

  const user = await userModel.findById(transaction.userId);
  if (user?.email) {
    await emailService.sendTransactionReceipt(
      user.email,
      transaction,
      user.preferredLanguage,
      user.displayName,
    );
  }
}

async function sendFailureEmail(transactionId: string, reason: string): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  if (!transaction?.userId) return;

  const user = await userModel.findById(transaction.userId);
  if (user?.email) {
    await emailService.sendTransactionFailure(
      user.email,
      transaction,
      reason,
      user.preferredLanguage,
      user.displayName,
    );
  }
}

async function sendTransactionPush(
  transactionId: string,
  status: "completed" | "failed",
  error?: string,
): Promise<void> {
  const transaction = await transactionModel.findById(transactionId);
  if (!transaction?.userId) return;

  try {
    if (status === "completed") {
      await pushService.sendTransactionComplete(transaction.userId, {
        transactionId: transaction.id,
        referenceNumber: transaction.referenceNumber,
        type: "withdraw",
        amount: String(transaction.amount),
        status: "completed",
        error,
      });
    } else {
      await pushService.sendTransactionFailed(transaction.userId, {
        transactionId: transaction.id,
        referenceNumber: transaction.referenceNumber,
        type: "withdraw",
        amount: String(transaction.amount),
        status: "failed",
        error,
      });
    }
  } catch (pushError) {
    console.error(`[${transactionId}] Push notification failed:`, pushError);
  }
}

async function sendTxnSms(
  transactionId: string,
  phoneNumber: string,
  amount: string,
  provider: string,
  kind: "transaction_completed" | "transaction_failed",
  errorMessage?: string,
): Promise<void> {
  try {
    const txRow = await transactionModel.findById(transactionId);
    if (!txRow?.userId) return;

    const user = await userModel.findById(txRow.userId);
    if (user?.smsOptOut) {
      console.log(`[${transactionId}] SMS notifications skipped (User Opted Out)`);
      return;
    }

    const ref = txRow?.referenceNumber ?? transactionId;
    await smsService.notifyTransactionEvent(phoneNumber, {
      referenceNumber: ref,
      type: "withdraw",
      amount: String(amount),
      provider,
      kind,
      errorMessage,
    });
  } catch (smsErr) {
    console.error(`[${transactionId}] SMS notification error`, smsErr);
  }
}

/**
 * Fetch pending MTN payouts from the database
 */
async function fetchPendingPayouts(provider: string): Promise<PendingPayout[]> {
  const result = await transactionModel.findByStatusAndProvider(
    TransactionStatus.Pending,
    provider,
    "withdraw",
    BATCH_SIZE,
  );

  return result.map(tx => ({
    transactionId: tx.id,
    phoneNumber: tx.phoneNumber,
    amount: String(tx.amount),
    provider: tx.provider,
  }));
}

/**
 * Process a single payout result item
 */
async function processSinglePayoutResult(
  payout: PendingPayout,
  result: BatchPayoutResult | undefined,
  batchOperationId: string,
): Promise<void> {
  // Find the batch item
  const batchItem = await batchItemModel.findByReferenceId(batchOperationId, payout.transactionId);

  if (!result) {
    console.error(`[${payout.transactionId}] No result returned from batch`);
    await transactionModel.updateStatus(
      payout.transactionId,
      TransactionStatus.Failed,
    );
    await transactionModel.patchMetadata(payout.transactionId, {
      batchError: "No result returned from batch processing",
    });

    // Update batch item status
    if (batchItem) {
      await batchItemModel.updateStatus(
        batchItem.id,
        BatchItemStatus.Failed,
        "No result returned from batch processing",
      );
    }
    return;
  }

  if (result.success) {
    await transactionModel.updateStatus(
      payout.transactionId,
      TransactionStatus.Completed,
    );

    if (result.providerReference) {
      await transactionModel.patchMetadata(payout.transactionId, {
        providerReference: result.providerReference,
      });
    }

    // Update batch item status
    if (batchItem) {
      await batchItemModel.updateStatus(
        batchItem.id,
        BatchItemStatus.Completed,
        undefined,
        result.providerReference,
      );
    }

    await notifyTransactionWebhook(payout.transactionId, "transaction.completed", {
      transactionModel,
      webhookService,
    });
    await sendTransactionEmail(payout.transactionId);
    await sendTransactionPush(payout.transactionId, "completed");
    await sendTxnSms(
      payout.transactionId,
      payout.phoneNumber,
      payout.amount,
      payout.provider,
      "transaction_completed",
    );

    await rabbitMQManager.publish(
      EXCHANGES.TRANSACTIONS,
      ROUTING_KEYS.TRANSACTION_COMPLETED,
      { transactionId: payout.transactionId, status: "completed" },
    );

    console.log(`[${payout.transactionId}] Batch payout completed successfully`);
  } else {
    const errorMsg = result.error || "Batch payout failed";
    
    await transactionModel.updateStatus(
      payout.transactionId,
      TransactionStatus.Failed,
    );
    await transactionModel.patchMetadata(payout.transactionId, {
      batchError: errorMsg,
    });

    // Update batch item status
    if (batchItem) {
      await batchItemModel.updateStatus(
        batchItem.id,
        BatchItemStatus.Failed,
        errorMsg,
        result.providerReference,
      );
    }

    await notifyTransactionWebhook(payout.transactionId, "transaction.failed", {
      transactionModel,
      webhookService,
    });
    await sendFailureEmail(payout.transactionId, errorMsg);
    await sendTransactionPush(payout.transactionId, "failed", errorMsg);
    await sendTxnSms(
      payout.transactionId,
      payout.phoneNumber,
      payout.amount,
      payout.provider,
      "transaction_failed",
      errorMsg,
    );

    await rabbitMQManager.publish(
      EXCHANGES.TRANSACTIONS,
      ROUTING_KEYS.TRANSACTION_FAILED,
      { transactionId: payout.transactionId, status: "failed", error: errorMsg },
    );

    console.log(`[${payout.transactionId}] Batch payout failed: ${errorMsg}`);
  }
}

/**
 * Process batch payout results and update individual transactions
 */
async function processBatchResults(
  results: BatchPayoutResult[],
  payouts: PendingPayout[],
  batchOperationId: string,
): Promise<void> {
  const resultMap = new Map(results.map(r => [r.referenceId, r]));
  const totalCount = payouts.length;
  let processedCount = 0;

  const processor = new ParallelBatchProcessor({
    concurrency: PARALLEL_CONCURRENCY,
    rateLimitPerSecond: RATE_LIMIT_PER_SECOND,
    circuitBreakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
    circuitBreakerResetMs: CIRCUIT_BREAKER_RESET_MS,
    maxRetries: 2,
  });

  const batchItems: BatchItem<PendingPayout>[] = payouts.map(p => ({
    id: p.transactionId,
    payload: p,
  }));

  const summary = await processor.processBatch(batchItems, async (item) => {
    const payout = item.payload;
    const result = resultMap.get(payout.transactionId);
    await processSinglePayoutResult(payout, result, batchOperationId);

    processedCount++;

    // Fire an intermediate progress webhook every PROGRESS_WEBHOOK_INTERVAL items
    if (processedCount % PROGRESS_WEBHOOK_INTERVAL === 0 && processedCount < totalCount) {
      await batchWebhookService.sendBatchIntermediateProgressWebhook(
        batchOperationId,
        processedCount,
        totalCount,
      ).catch(err => {
        console.error(`[BatchPayoutWorker] Failed to send progress webhook at ${processedCount}/${totalCount}:`, err);
      });
    }

    return { transactionId: payout.transactionId };
  });

  if (summary.circuitBreakerTripped) {
    console.error(
      `[BatchPayoutWorker] Circuit breaker tripped: ${summary.failed} failures in batch processing`,
    );
  }

  console.log(
    `[BatchPayoutWorker] Parallel processing completed: ${summary.succeeded}/${summary.total} succeeded, ${summary.failed} failed in ${summary.totalDurationMs}ms`,
  );

  // Send progress webhook if configured
  await batchWebhookService.sendBatchCompletionWebhook(batchOperationId).catch(err => {
    console.error(`[BatchPayoutWorker] Failed to send completion webhook:`, err);
  });
}

/**
 * Process a single batch of payouts for a provider
 */
async function processBatch(provider: string): Promise<void> {
  const payouts = await fetchPendingPayouts(provider);

  if (payouts.length === 0) {
    return;
  }

  console.log(`[BatchPayoutWorker] Processing ${payouts.length} pending ${provider} payouts`);

  // Create batch operation record
  const batchReference = `BATCH-${provider.toUpperCase()}-${Date.now()}-${uuidv4().slice(0, 8)}`;
  const batchOperation = await batchOperationModel.create({
    batchReference,
    provider,
    operationType: "payout",
    totalItems: payouts.length,
  });

  console.log(`[BatchPayoutWorker] Created batch operation ${batchOperation.id} with reference ${batchReference}`);

  // Update batch operation status to processing
  await batchOperationModel.updateStatus(batchOperation.id, BatchOperationStatus.Processing);

  // Create batch item records
  for (const payout of payouts) {
    await batchItemModel.create({
      batchId: batchOperation.id,
      transactionId: payout.transactionId,
      referenceId: payout.transactionId,
      phoneNumber: payout.phoneNumber,
      amount: payout.amount,
    });
  }

  const batchItems: BatchPayoutItem[] = payouts.map(p => ({
    referenceId: p.transactionId,
    phoneNumber: p.phoneNumber,
    amount: p.amount,
  }));

  const startTime = Date.now();
  const result = await mobileMoneyService.sendBatchPayout(provider, batchItems);
  const durationMs = Date.now() - startTime;

  // Record metrics
  const successCount = result.results.filter(r => r.success).length;
  const failureCount = result.results.filter(r => !r.success).length;

  batchPayoutTotal.inc({ provider, status: result.success ? "success" : "partial" });
  batchPayoutItemsTotal.inc({ provider, status: "success" }, successCount);
  batchPayoutItemsTotal.inc({ provider, status: "failed" }, failureCount);
  batchPayoutDurationSeconds.observe({ provider }, durationMs / 1000);
  batchPayoutSize.observe({ provider }, payouts.length);

  console.log(
    `[BatchPayoutWorker] Batch completed in ${durationMs}ms: ${successCount}/${payouts.length} successful`,
  );

  await processBatchResults(result.results, payouts, batchOperation.id);
}

/**
 * Main batch worker loop
 */
let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

async function runBatchCycle(): Promise<void> {
  if (isRunning) {
    console.log("[BatchPayoutWorker] Previous cycle still running, skipping");
    return;
  }

  isRunning = true;
  try {
    for (const provider of SUPPORTED_PROVIDERS) {
      await processBatch(provider);
    }
  } catch (error) {
    console.error("[BatchPayoutWorker] Error in batch cycle:", error);
  } finally {
    isRunning = false;
  }
}

export function startBatchPayoutWorker(): void {
  if (intervalId) {
    console.log("[BatchPayoutWorker] Already running");
    return;
  }

  console.log(`[BatchPayoutWorker] Starting with interval ${BATCH_INTERVAL_MS}ms`);
  
  // Run immediately on start
  runBatchCycle().catch(err => 
    console.error("[BatchPayoutWorker] Initial cycle error:", err)
  );

  // Then run on interval
  intervalId = setInterval(() => {
    runBatchCycle().catch(err =>
      console.error("[BatchPayoutWorker] Interval cycle error:", err)
    );
  }, BATCH_INTERVAL_MS);
}

export function stopBatchPayoutWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[BatchPayoutWorker] Stopped");
  }
}

export const batchPayoutWorker = {
  start: startBatchPayoutWorker,
  stop: stopBatchPayoutWorker,
  isRunning: () => isRunning,
};
