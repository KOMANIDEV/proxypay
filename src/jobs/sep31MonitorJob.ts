import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { Sep31Status, mapToSep31Status, isValidTransition } from "../stellar/sep31";
import { getStellarServer } from "../config/stellar";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import * as StellarSdk from "stellar-sdk";
import logger from "../utils/logger";

/**
 * SEP-31 Transaction Monitor Job
 * Schedule: Every minute
 * Monitors SEP-31 transactions for payment receipt and status updates.
 * Initiates payouts when transactions reach pending_receiver status.
 */
export async function runSep31MonitorJob(): Promise<void> {
  const transactionModel = new TransactionModel();
  const server = getStellarServer();
  const mobileMoneyService = new MobileMoneyService();

  try {
    // Find all pending SEP-31 transactions
    const result = await pool.query(`
      SELECT id, metadata, stellar_address, amount, status
      FROM transactions
      WHERE status IN ('pending', 'processing')
        AND provider = 'stellar-sep31'
        AND metadata->'sep31' IS NOT NULL
    `);

    logger.info({ count: result.rows.length }, '[sep31-monitor] Found SEP-31 transactions to check');

    for (const row of result.rows) {
      try {
        const metadata = row.metadata as any;
        const sep31Meta = metadata.sep31;
        const currentStatus = mapToSep31Status(row.status, metadata);

        // Skip if already completed or errored
        if (currentStatus === Sep31Status.Completed || currentStatus === Sep31Status.Error) {
          continue;
        }

        // Check if payment has been received
        if (currentStatus === Sep31Status.PendingSender) {
          const paymentReceived = await checkPaymentReceived(server, sep31Meta, row.amount);
          if (paymentReceived) {
            // Update to pending_stellar
            const newStatus = Sep31Status.PendingStellar;
            if (isValidTransition(currentStatus, newStatus)) {
              await updateSep31Status(row.id, newStatus, metadata);
              logger.info({ transactionId: row.id, newStatus }, '[sep31-monitor] Transaction payment received, status updated');
            }
          }
        }

        // For pending_stellar, we could add logic to check Stellar network confirmation
        // For now, we'll assume it moves to pending_receiver after payment confirmation

        // For pending_receiver, trigger payout (integrate with mobile money service)
        if (currentStatus === Sep31Status.PendingReceiver) {
          await processSep31Payout(row, sep31Meta, mobileMoneyService, transactionModel);
        }

      } catch (error) {
        logger.error({ err: error, transactionId: row.id }, '[sep31-monitor] Error processing transaction');
      }
    }
  } catch (error) {
    logger.error({ err: error }, '[sep31-monitor] Job failed');
  }
}

async function checkPaymentReceived(
  server: StellarSdk.Horizon.Server,
  sep31Meta: any,
  expectedAmount: string
): Promise<boolean> {
  try {
    // Query transactions for the receiving account with the memo
    const operations = await server
      .operations()
      .forAccount(sep31Meta.stellar_account_id || process.env.STELLAR_RECEIVING_ACCOUNT)
      .includeFailed(false)
      .limit(10)
      .call();

    // Look for payment operations with matching amount (memo check removed as memos are at transaction level)
    for (const op of operations.records) {
      if (op.type === "payment") {
        const amount = parseFloat(op.amount);
        const expected = parseFloat(expectedAmount);
        if (Math.abs(amount - expected) < 0.0000001) { // Account for floating point precision
          return true;
        }
      }
    }
  } catch (error) {
    console.error("[sep31-monitor] Error checking payment:", error);
  }

  return false;
}

async function updateSep31Status(
  transactionId: string,
  newStatus: Sep31Status,
  currentMetadata: any
): Promise<void> {
  const transactionModel = new TransactionModel();

  const updatedMetadata = {
    ...currentMetadata,
    sep31: {
      ...currentMetadata.sep31,
      status: newStatus,
    },
  };

  await transactionModel.updateMetadata(transactionId, updatedMetadata);

  // Update transaction status based on SEP-31 status
  let transactionStatus: TransactionStatus;
  switch (newStatus) {
    case Sep31Status.Completed:
      transactionStatus = TransactionStatus.Completed;
      break;
    case Sep31Status.Error:
      transactionStatus = TransactionStatus.Failed;
      break;
    default:
      transactionStatus = TransactionStatus.Pending;
  }

  await transactionModel.updateStatus(transactionId, transactionStatus);
}

/**
 * Process SEP-31 payout when transaction reaches pending_receiver status.
 * Uses MobileMoneyService to send payout to the destination.
 */
async function processSep31Payout(
  row: any,
  sep31Meta: any,
  mobileMoneyService: MobileMoneyService,
  transactionModel: TransactionModel
): Promise<void> {
  const transactionId = row.id;
  const amount = row.amount;
  const metadata = row.metadata as any;

  // Extract payout details from metadata
  const receiverAccount = sep31Meta.receiver_account_number;
  const receiverRouting = sep31Meta.receiver_routing_number;
  const payoutType = sep31Meta.payout_type || "mobile_money";
  const amountOut = sep31Meta.amount_out || row.amount;

  if (!receiverAccount) {
    logger.warn({ transactionId }, '[sep31-monitor] No receiver account number, cannot process payout');
    return;
  }

  // Determine provider based on routing number or default
  const provider = determineProvider(receiverRouting, payoutType);

  try {
    logger.info({ transactionId, provider, receiverAccount, amount: amountOut }, '[sep31-monitor] Initiating payout');

    // Send payout via mobile money service
    const payoutResult = await mobileMoneyService.sendPayout(provider, receiverAccount, amountOut);

    if (payoutResult.success) {
      // Update status to completed
      const newStatus = Sep31Status.Completed;
      if (isValidTransition(Sep31Status.PendingReceiver, newStatus)) {
        await updateSep31Status(transactionId, newStatus, metadata);
        
        // Store payout reference in metadata
        const updatedMetadata = {
          ...metadata,
          sep31: {
            ...metadata.sep31,
            status: newStatus,
            payout_reference: payoutResult.data?.reference || payoutResult.data?.transactionId,
            payout_provider: provider,
            completed_at: new Date().toISOString(),
          },
        };
        await transactionModel.updateMetadata(transactionId, updatedMetadata);
        
        logger.info({ transactionId, provider, payoutRef: payoutResult.data?.reference }, '[sep31-monitor] Payout completed successfully');
      }
    } else {
      // Payout failed - update to error status
      const newStatus = Sep31Status.Error;
      if (isValidTransition(Sep31Status.PendingReceiver, newStatus)) {
        await updateSep31Status(transactionId, newStatus, metadata);
        logger.error({ transactionId, provider, error: payoutResult.error }, '[sep31-monitor] Payout failed');
      }
    }
  } catch (error) {
    logger.error({ err: error, transactionId, provider }, '[sep31-monitor] Payout error');
    // Update to error status on exception
    const newStatus = Sep31Status.Error;
    if (isValidTransition(Sep31Status.PendingReceiver, newStatus)) {
      await updateSep31Status(transactionId, newStatus, metadata);
    }
  }
}

/**
 * Determine mobile money provider based on routing number and payout type
 */
function determineProvider(routingNumber: string | null | undefined, payoutType: string): string {
  if (payoutType !== "mobile_money") {
    return "mtn"; // Default fallback
  }
  
  // Map common routing prefixes to providers
  if (routingNumber) {
    const prefix = routingNumber.substring(0, 4);
    switch (prefix) {
      case "024":
      case "054":
      case "055":
      case "059":
        return "mtn";
      case "027":
      case "057":
        return "airtel";
      case "020":
      case "050":
        return "orange";
      case "023":
      case "053":
        return "vodacom";
      case "026":
      case "056":
        return "tigo";
    }
  }
  
  return "mtn"; // Default fallback
}