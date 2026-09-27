import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { redisClient } from "../config/redis";
import logger from "../utils/logger";

const transactionModel = new TransactionModel();

export type StalenessAlertState = "new" | "notified_once" | "notified_multiple";

export interface StaleTransactionState {
  transactionId: string;
  state: StalenessAlertState;
  alertCount: number;
  lastAlertedAt: string;
  escalatedToReview: boolean;
}

export const STALE_TX_MAX_ALERTS = parseInt(
  process.env.STALE_TX_MAX_ALERTS || "3",
  10
);

export const STALE_TX_ESCALATION_THRESHOLD = parseInt(
  process.env.STALE_TX_ESCALATION_THRESHOLD || "3",
  10
);

const inMemoryStaleStates = new Map<string, StaleTransactionState>();

export async function getStaleTransactionState(
  transactionId: string
): Promise<StaleTransactionState> {
  if (redisClient?.isOpen) {
    try {
      const data = await redisClient.get(`stale:tx:${transactionId}`);
      if (data) return JSON.parse(data);
    } catch (err) {
      logger.warn({ error: err }, "Failed to get stale tx state from Redis");
    }
  }

  const existing = inMemoryStaleStates.get(transactionId);
  if (existing) return existing;

  return {
    transactionId,
    state: "new",
    alertCount: 0,
    lastAlertedAt: new Date().toISOString(),
    escalatedToReview: false,
  };
}

export async function recordStaleAlert(
  transactionId: string
): Promise<{ state: StaleTransactionState; shouldAlert: boolean; shouldEscalate: boolean }> {
  const current = await getStaleTransactionState(transactionId);

  const newAlertCount = current.alertCount + 1;
  let newState: StalenessAlertState = "notified_once";
  if (newAlertCount > 1) {
    newState = "notified_multiple";
  }

  const shouldEscalate =
    newAlertCount >= STALE_TX_ESCALATION_THRESHOLD && !current.escalatedToReview;
  const shouldAlert = current.alertCount < STALE_TX_MAX_ALERTS;

  const updated: StaleTransactionState = {
    transactionId,
    state: newState,
    alertCount: newAlertCount,
    lastAlertedAt: new Date().toISOString(),
    escalatedToReview: current.escalatedToReview || shouldEscalate,
  };

  inMemoryStaleStates.set(transactionId, updated);

  if (redisClient?.isOpen) {
    try {
      await redisClient.setEx(
        `stale:tx:${transactionId}`,
        86400 * 7, // 7 days retention
        JSON.stringify(updated)
      );
    } catch (err) {
      logger.warn({ error: err }, "Failed to save stale tx state to Redis");
    }
  }

  return { state: updated, shouldAlert, shouldEscalate };
}

export async function clearStaleTransactionState(
  transactionId: string
): Promise<void> {
  inMemoryStaleStates.delete(transactionId);
  if (redisClient?.isOpen) {
    try {
      await redisClient.del(`stale:tx:${transactionId}`);
    } catch (err) {
      logger.warn({ error: err }, "Failed to delete stale tx state from Redis");
    }
  }
}

export function _clearAllStaleStates(): void {
  inMemoryStaleStates.clear();
}


/**
 * Stale Transaction Watchdog
 * Schedule: Every hour (0 * * * *)
 *
 * Finds transactions stuck in 'pending' for over STALE_TRANSACTION_HOURS (default: 12).
 * For each stale transaction it calls the provider's Get Status endpoint:
 *   - 'completed' → finalises as completed
 *   - 'failed'    → finalises as failed
 *   - 'pending' or 'unknown' → expires as failed (no infinite pending in DB)
 */
export async function runStaleTransactionWatchdog(
  service?: InstanceType<typeof MobileMoneyService>,
): Promise<void> {
  const staleHours = parseInt(
    process.env.STALE_TRANSACTION_HOURS || "12",
    10,
  );

  const result = await pool.query<{
    id: string;
    reference_number: string;
    provider: string;
    created_at: Date;
  }>(
    `SELECT id, reference_number, provider, created_at
     FROM transactions
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '${staleHours} hours'
     ORDER BY created_at ASC`,
  );

  if (result.rows.length === 0) {
    logger.info('No stale transactions found');
    return;
  }

  logger.info(
    { count: result.rows.length, thresholdHours: staleHours },
    'Found stale transactions'
  );

  const mobileMoneyService = service ?? new MobileMoneyService();

  let resolved = 0;
  let expired = 0;
  let escalated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of result.rows) {
    const { state, shouldAlert, shouldEscalate } = await recordStaleAlert(row.id);

    if (shouldEscalate) {
      await transactionModel.updateStatus(row.id, TransactionStatus.Review);
      logger.warn(
        {
          transactionId: row.id,
          reference: row.reference_number,
          alertCount: state.alertCount,
        },
        'Escalated stale transaction to manual review after exceeding alert threshold'
      );
      escalated++;
      continue;
    }

    if (!shouldAlert) {
      logger.info(
        {
          transactionId: row.id,
          reference: row.reference_number,
          alertCount: state.alertCount,
        },
        'Stale transaction alert limit reached; skipping further notifications'
      );
      skipped++;
      continue;
    }

    try {
      // Check transaction status with provider
      const statusResponse = await mobileMoneyService.getTransactionStatus(
        row.provider as any,
        row.reference_number,
      );
      
      if (statusResponse.success && statusResponse.data) {
        const providerStatus = statusResponse.data.status;
        
        if (providerStatus === "completed" || providerStatus === "successful") {
          await transactionModel.updateStatus(row.id, TransactionStatus.Completed);
          await clearStaleTransactionState(row.id);
          logger.info(
            { transactionId: row.id, reference: row.reference_number },
            'Resolved stale transaction as completed'
          );
          resolved++;
        } else if (providerStatus === "failed" || providerStatus === "rejected") {
          await transactionModel.updateStatus(row.id, TransactionStatus.Failed);
          await clearStaleTransactionState(row.id);
          logger.info(
            { transactionId: row.id, reference: row.reference_number },
            'Resolved stale transaction as failed'
          );
          resolved++;
        } else {
          // Still pending or unknown - expire it as failed
          await transactionModel.updateStatus(row.id, TransactionStatus.Failed);
          await clearStaleTransactionState(row.id);
          logger.warn(
            {
              transactionId: row.id,
              reference: row.reference_number,
              providerStatus,
              stalenessState: state.state,
              alertCount: state.alertCount,
            },
            'Expired stale transaction (still pending/unknown at provider)'
          );
          expired++;
        }
      } else {
        // Can't verify with provider - mark as failed after stale period
        await transactionModel.updateStatus(row.id, TransactionStatus.Failed);
        await clearStaleTransactionState(row.id);
        logger.warn(
          {
            transactionId: row.id,
            reference: row.reference_number,
            error: statusResponse.error,
            stalenessState: state.state,
            alertCount: state.alertCount,
          },
          'Expired stale transaction (provider status check failed)'
        );
        expired++;
      }
    } catch (err) {
      logger.error(
        { error: err, transactionId: row.id },
        'Error processing stale transaction'
      );
      errors++;
    }
  }

  logger.info(
    { resolved, expired, escalated, skipped, errors },
    'Stale transaction watchdog completed'
  );
}
