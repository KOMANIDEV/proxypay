import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { Sep31Status, mapToSep31Status, isValidTransition } from "../stellar/sep31";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import * as StellarSdk from "stellar-sdk";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";
import {
  createFeeBumpAttempt,
  submitFeeBumpWithRetry,
  manualRetryFeeBump,
  getFeeBumpRecoveryStats,
} from "../services/feeBumpRecoveryService";

/**
 * SEP-31 Fee Bump Job
 * Schedule: Every 30 seconds
 * Monitors SEP-31 transactions stuck in pending_stellar and bumps fees if needed.
 *
 * Uses feeBumpRecoveryService for exponential-backoff retries, dead-letter
 * queue routing, and audit logging so failures no longer go silently unnoticed.
 */
export async function runSep31FeeBumpJob(): Promise<void> {
  const transactionModel = new TransactionModel();
  const server = getStellarServer();

  try {
    // Find SEP-31 transactions in pending_stellar for > 60s
    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const result = await pool.query(`
      SELECT id, metadata, stellar_address, amount, status
      FROM transactions
      WHERE status = 'pending'
        AND provider = 'stellar-sep31'
        AND metadata->'sep31'->>'status' = 'pending_stellar'
        AND metadata->'sep31'->>'submittedAt' IS NOT NULL
        AND metadata->'sep31'->>'submittedAt' < $1
    `, [sixtySecondsAgo]);

    console.log(`[sep31-fee-bump] Found ${result.rows.length} stuck SEP-31 transactions`);

    for (const row of result.rows) {
      try {
        const metadata = row.metadata as any;
        const sep31Meta = metadata.sep31;
        const transactionHash = sep31Meta.transactionHash;

        // Check if transaction is still pending on the network
        const isConfirmed = await checkTransactionConfirmed(server, transactionHash);
        if (isConfirmed) {
          console.log(`[sep31-fee-bump] Transaction ${row.id} (${transactionHash}) is now confirmed`);
          await updateSep31Status(row.id, Sep31Status.PendingReceiver, metadata);
          continue;
        }

        // Use feeBumpRecoveryService to attempt fee bump with exponential backoff,
        // dead-letter routing, and structured audit logging.
        const feeBumpAttempt = await createFeeBumpAttempt({
          transactionId: row.id,
          originalHash: transactionHash,
          feeAmount: StellarSdk.BASE_FEE,
        });

        const feeAccount = process.env.STELLAR_FEE_BUMP_SECRET
          ? StellarSdk.Keypair.fromSecret(process.env.STELLAR_FEE_BUMP_SECRET).publicKey()
          : "";

        const recoveryResult = await submitFeeBumpWithRetry(feeBumpAttempt.id, feeAccount);

        if (recoveryResult.status === "confirmed") {
          console.log(
            `[sep31-fee-bump] Fee bump confirmed for ${row.id} via recovery service (hash: ${recoveryResult.fee_bump_hash})`,
          );
          const updatedMetadata = {
            ...metadata,
            sep31: {
              ...sep31Meta,
              transactionHash: recoveryResult.fee_bump_hash ?? transactionHash,
              submittedAt: new Date().toISOString(),
              feeBumps: [
                ...(sep31Meta.feeBumps || []),
                {
                  previousHash: transactionHash,
                  newHash: recoveryResult.fee_bump_hash,
                  bumpedAt: new Date().toISOString(),
                },
              ],
            },
          };
          await transactionModel.updateMetadata(row.id, updatedMetadata);
        } else if (recoveryResult.status === "dead_letter") {
          console.error(
            `[sep31-fee-bump] Transaction ${row.id} moved to dead-letter queue after max retries`,
          );
          await updateSep31Status(row.id, Sep31Status.Error, metadata);
        } else {
          console.log(
            `[sep31-fee-bump] Fee bump for ${row.id} scheduled for retry (status: ${recoveryResult.status})`,
          );
        }
      } catch (error) {
        console.error(`[sep31-fee-bump] Error processing SEP-31 transaction ${row.id}:`, error);
      }
    }

    // Log aggregate recovery stats for observability
    try {
      const stats = await getFeeBumpRecoveryStats();
      console.log(
        `[sep31-fee-bump] Recovery stats — total: ${stats.total}, confirmed: ${stats.confirmed}, ` +
          `failed: ${stats.failed}, dead_letter: ${stats.dead_letter}, success_rate: ${(stats.success_rate * 100).toFixed(1)}%`,
      );
    } catch (statsErr) {
      console.warn("[sep31-fee-bump] Could not fetch recovery stats:", statsErr);
    }
  } catch (error) {
    console.error("[sep31-fee-bump] Job failed:", error);
  }
}

/**
 * Manually retry a dead-lettered fee bump attempt.
 * Exposed for use by admin endpoints.
 */
export async function retryDeadLetteredFeeBump(attemptId: string): Promise<void> {
  const feeAccount = process.env.STELLAR_FEE_BUMP_SECRET
    ? StellarSdk.Keypair.fromSecret(process.env.STELLAR_FEE_BUMP_SECRET).publicKey()
    : "";
  await manualRetryFeeBump(attemptId, feeAccount);
  console.log(`[sep31-fee-bump] Manual retry triggered for dead-letter attempt ${attemptId}`);
}

async function checkTransactionConfirmed(server: StellarSdk.Horizon.Server, hash: string): Promise<boolean> {
  try {
    await server.transactions().transaction(hash).call();
    return true;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return false;
    }
    console.warn(`[sep31-fee-bump] Error checking transaction ${hash}:`, error.message);
    return false;
  }
}

async function performSep31FeeBump(
  transactionId: string,
  destinationAddress: string,
  amount: string,
  metadata: any,
  server: StellarSdk.Horizon.Server
): Promise<void> {
  const transactionModel = new TransactionModel();
  const sep31Meta = metadata.sep31;

  try {
    // Use dedicated fee-bump account
    const feeBumpSecret = process.env.STELLAR_FEE_BUMP_SECRET;
    if (!feeBumpSecret) {
      throw new Error("STELLAR_FEE_BUMP_SECRET not configured");
    }
    const keypair = StellarSdk.Keypair.fromSecret(feeBumpSecret);
    const account = await server.loadAccount(keypair.publicKey());
    const paymentAsset = getConfiguredPaymentAsset();

    // Calculate new fee (double previous, max 1 XLM in stroops)
    const previousFee = sep31Meta.feeBumps?.length > 0
      ? sep31Meta.feeBumps[sep31Meta.feeBumps.length - 1].fee
      : StellarSdk.BASE_FEE;
    const newFee = Math.min(previousFee * 2, 100000);

    // Rebuild original transaction (assume payment)
    const txBuilder = new StellarSdk.TransactionBuilder(account, {
      fee: newFee.toString(),
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destinationAddress,
          asset: paymentAsset,
          amount: amount,
        })
      )
      .setTimeout(30)
      .build();

    txBuilder.sign(keypair);
    const response = await server.submitTransaction(txBuilder);

    console.log(`[sep31-fee-bump] Fee bumped SEP-31 transaction ${transactionId} with new hash ${response.hash}, fee: ${newFee}`);

    // Update metadata
    const updatedMetadata = {
      ...metadata,
      sep31: {
        ...sep31Meta,
        transactionHash: response.hash,
        submittedAt: new Date().toISOString(),
        feeBumps: [
          ...(sep31Meta.feeBumps || []),
          {
            previousHash: sep31Meta.transactionHash,
            newHash: response.hash,
            fee: newFee,
            bumpedAt: new Date().toISOString(),
          },
        ],
      },
    };
    await transactionModel.updateMetadata(transactionId, updatedMetadata);
  } catch (error) {
    console.error(`[sep31-fee-bump] Failed to fee bump SEP-31 transaction ${transactionId}:`, error);
    throw error;
  }
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
  // Update transaction status
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
