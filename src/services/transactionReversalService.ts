/**
 * #483 – Transaction Reversal Capability
 *
 * Error correction for completed payments needs more than flipping a status:
 * operators need durable state tracking, the affected parties need to be
 * notified, and auditors need an append-only trail of who reversed what and
 * why. This service layers those concerns on top of the existing compensating
 * ledger entry:
 *
 *   * `reverse()` drives a reversal record through the state machine
 *     `requested -> posted -> notified` (or `failed`), writing every
 *     transition to `transaction_reversal_events`.
 *   * `listReversals()` / `getReversal()` expose the history for support and
 *     audit tooling.
 *   * `retryNotification()` re-delivers notifications for reversals that were
 *     posted but never announced.
 *
 * The ledger posting itself is delegated to `ledgerService.postReversal`,
 * which remains idempotent, so a retried reversal never double-posts.
 */

import { TransactionModel, TransactionStatus } from "../models/transaction";
import { ledgerService, ReversalResult } from "./ledgerService";
import { queryRead, queryWrite } from "../config/database";
import logger from "../utils/logger";

export type ReversalStatus =
  | "requested"
  | "posted"
  | "notified"
  | "failed";

export interface ReversalRecord {
  id: string;
  transactionId: string;
  originalReference: string;
  reversalReference: string | null;
  reason: string;
  status: ReversalStatus;
  requestedBy: string | null;
  approvedBy: string | null;
  ledgerEntries: number;
  alreadyReversed: boolean;
  error: string | null;
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReversalAuditEvent {
  id: number;
  reversalId: string;
  fromStatus: ReversalStatus | null;
  toStatus: ReversalStatus;
  actorId: string | null;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export interface TransactionReversalResult {
  transaction: Awaited<ReturnType<TransactionModel["findById"]>>;
  reversal: ReversalResult;
  /** Durable reversal record for state tracking and audit. */
  record: ReversalRecord | null;
  notified: boolean;
}

const REVERSAL_COLUMNS = `
  id, transaction_id, original_reference, reversal_reference, reason,
  status, requested_by, approved_by, ledger_entries, already_reversed,
  error, notified_at, created_at, updated_at
`;

function mapReversalRow(row: any): ReversalRecord {
  return {
    id: String(row.id),
    transactionId: row.transaction_id,
    originalReference: row.original_reference,
    reversalReference: row.reversal_reference ?? null,
    reason: row.reason,
    status: row.status as ReversalStatus,
    requestedBy: row.requested_by ?? null,
    approvedBy: row.approved_by ?? null,
    ledgerEntries: Number(row.ledger_entries ?? 0),
    alreadyReversed: Boolean(row.already_reversed),
    error: row.error ?? null,
    notifiedAt: row.notified_at ? new Date(row.notified_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class TransactionReversalService {
  constructor(
    private readonly transactionModel = new TransactionModel(),
    /**
     * Persistence is optional so the unit tests (and any caller that only
     * needs the ledger behaviour) can run without a database.
     */
    private readonly persist = true,
  ) {}

  // -------------------------------------------------------------------------
  // Reversal execution
  // -------------------------------------------------------------------------

  async reverse(
    transactionId: string,
    reason: string,
    actorId?: string,
    options: { allowCompleted?: boolean } = {},
  ): Promise<TransactionReversalResult> {
    const transaction = await this.transactionModel.findById(transactionId);
    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    const allowedStatuses = [
      TransactionStatus.Failed,
      TransactionStatus.Dispute,
      ...(options.allowCompleted ? [TransactionStatus.Completed] : []),
    ];

    // Already reversed: keep the existing behaviour (no double post) but still
    // surface a record so the audit trail is complete.
    if (transaction.status === TransactionStatus.Reversed) {
      return {
        transaction,
        reversal: { alreadyReversed: true, entries: [] },
        record: await this.getLatestReversal(transaction.id),
        notified: false,
      };
    }

    if (!allowedStatuses.includes(transaction.status)) {
      throw new Error(
        `Cannot reverse transaction in status: ${transaction.status}`,
      );
    }

    const record = await this.createReversalRecord({
      transactionId: transaction.id,
      originalReference: transaction.referenceNumber,
      reason,
      requestedBy: actorId,
    });

    try {
      const reversal = await ledgerService.postReversal(
        transaction.id,
        transaction.referenceNumber,
        reason,
        actorId,
      );

      // ledgerService derives the compensating entry's reference as
      // `REV-<original>`; mirror it so the audit trail can join the two.
      const reversalReference = `REV-${transaction.referenceNumber}`;

      if (transaction.status !== TransactionStatus.Reversed) {
        await this.transactionModel.updateStatus(
          transaction.id,
          TransactionStatus.Reversed,
        );
      }

      await this.transition(record.id, "posted", actorId, {
        reversalReference,
        ledgerEntries: reversal.entries?.length ?? 0,
        alreadyReversed: reversal.alreadyReversed,
      });

      const notified = await this.notifyReversal({
        transaction,
        reason,
        reversalReference,
        reversalId: record.id,
      });

      if (notified) {
        await this.transition(record.id, "notified", actorId, {});
      }

      const updated = await this.transactionModel.findById(transaction.id);
      return {
        transaction: updated ?? transaction,
        reversal,
        record: await this.getReversal(record.id),
        notified,
      };
    } catch (error) {
      await this.transition(record.id, "failed", actorId, {
        error: String(error),
      });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // State tracking
  // -------------------------------------------------------------------------

  private async createReversalRecord(input: {
    transactionId: string;
    originalReference: string;
    reason: string;
    requestedBy?: string;
  }): Promise<ReversalRecord> {
    if (!this.persist) {
      return {
        id: "unpersisted",
        transactionId: input.transactionId,
        originalReference: input.originalReference,
        reversalReference: null,
        reason: input.reason,
        status: "requested",
        requestedBy: input.requestedBy ?? null,
        approvedBy: null,
        ledgerEntries: 0,
        alreadyReversed: false,
        error: null,
        notifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    const { rows } = await queryWrite<any>(
      `INSERT INTO transaction_reversals
         (transaction_id, original_reference, reason, status, requested_by)
       VALUES ($1,$2,$3,'requested',$4)
       RETURNING ${REVERSAL_COLUMNS}`,
      [
        input.transactionId,
        input.originalReference,
        input.reason,
        input.requestedBy ?? null,
      ],
    );

    const record = mapReversalRow(rows[0]);
    await this.appendAuditEvent(record.id, null, "requested", input.requestedBy, {
      reason: input.reason,
    });
    return record;
  }

  /**
   * Move a reversal to the next state and append the audit event. Transitions
   * are validated so a reversal can never move backwards out of a terminal
   * state.
   */
  private async transition(
    reversalId: string,
    toStatus: ReversalStatus,
    actorId?: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.persist || reversalId === "unpersisted") return;

    const current = await this.getReversal(reversalId);
    if (current && isTerminal(current.status)) {
      logger.warn(
        { reversalId, from: current.status, to: toStatus },
        "[tx-reversal] refusing transition out of terminal state",
      );
      return;
    }

    const sets: string[] = ["status = $2", "updated_at = NOW()"];
    const params: unknown[] = [reversalId, toStatus];
    let index = 3;

    if (detail.reversalReference !== undefined) {
      sets.push(`reversal_reference = $${index++}`);
      params.push(detail.reversalReference);
    }
    if (detail.ledgerEntries !== undefined) {
      sets.push(`ledger_entries = $${index++}`);
      params.push(detail.ledgerEntries);
    }
    if (detail.alreadyReversed !== undefined) {
      sets.push(`already_reversed = $${index++}`);
      params.push(detail.alreadyReversed);
    }
    if (detail.error !== undefined) {
      sets.push(`error = $${index++}`);
      params.push(detail.error);
    }
    if (toStatus === "notified") {
      sets.push(`notified_at = NOW()`);
    }

    await queryWrite(
      `UPDATE transaction_reversals SET ${sets.join(", ")} WHERE id = $1`,
      params,
    );

    await this.appendAuditEvent(
      reversalId,
      current?.status ?? null,
      toStatus,
      actorId,
      detail,
    );
  }

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------

  private async appendAuditEvent(
    reversalId: string,
    fromStatus: ReversalStatus | null,
    toStatus: ReversalStatus,
    actorId?: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.persist || reversalId === "unpersisted") return;

    try {
      await queryWrite(
        `INSERT INTO transaction_reversal_events
           (reversal_id, from_status, to_status, actor_id, detail)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          reversalId,
          fromStatus,
          toStatus,
          actorId ?? null,
          JSON.stringify(detail),
        ],
      );
      logger.audit(
        { reversalId, fromStatus, toStatus, actorId },
        "[tx-reversal] reversal audit event",
      );
    } catch (error) {
      logger.warn(
        { error, reversalId },
        "[tx-reversal] failed to append audit event",
      );
    }
  }

  async getReversal(reversalId: string): Promise<ReversalRecord | null> {
    if (!this.persist || reversalId === "unpersisted") return null;

    const { rows } = await queryRead<any>(
      `SELECT ${REVERSAL_COLUMNS} FROM transaction_reversals WHERE id = $1`,
      [reversalId],
    );
    return rows[0] ? mapReversalRow(rows[0]) : null;
  }

  async getLatestReversal(
    transactionId: string,
  ): Promise<ReversalRecord | null> {
    if (!this.persist) return null;

    const { rows } = await queryRead<any>(
      `SELECT ${REVERSAL_COLUMNS} FROM transaction_reversals
        WHERE transaction_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [transactionId],
    );
    return rows[0] ? mapReversalRow(rows[0]) : null;
  }

  /** Full reversal history for a transaction, newest first. */
  async listReversals(
    transactionId: string,
  ): Promise<ReversalRecord[]> {
    if (!this.persist) return [];

    const { rows } = await queryRead<any>(
      `SELECT ${REVERSAL_COLUMNS} FROM transaction_reversals
        WHERE transaction_id = $1
        ORDER BY created_at DESC`,
      [transactionId],
    );
    return rows.map(mapReversalRow);
  }

  /** Ordered audit trail for a reversal. */
  async getAuditTrail(reversalId: string): Promise<ReversalAuditEvent[]> {
    if (!this.persist) return [];

    const { rows } = await queryRead<any>(
      `SELECT id, reversal_id, from_status, to_status, actor_id, detail, created_at
         FROM transaction_reversal_events
        WHERE reversal_id = $1
        ORDER BY created_at ASC, id ASC`,
      [reversalId],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      reversalId: row.reversal_id,
      fromStatus: row.from_status ?? null,
      toStatus: row.to_status,
      actorId: row.actor_id ?? null,
      detail: row.detail ?? {},
      createdAt: new Date(row.created_at),
    }));
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /**
   * Announce a completed reversal to the merchant. Notification delivery is
   * best-effort: a failure is recorded but never fails the reversal itself.
   */
  private async notifyReversal(input: {
    transaction: any;
    reason: string;
    reversalReference: string | null;
    reversalId: string;
  }): Promise<boolean> {
    if (!input.transaction?.userId) return false;

    try {
      // Imported lazily: the notification router pulls in the email/SMS/push
      // clients, and reversal bookkeeping must not depend on them loading.
      const { notificationRouter } = await import("./notificationRouter");

      await notificationRouter.routeNotification({
        userId: input.transaction.userId,
        transactionId: input.transaction.id,
        severity: "high",
        category: "transaction",
        title: "Transaction Reversed",
        message:
          `Your ${input.transaction.type ?? "transaction"} of ` +
          `${input.transaction.amount} ${String(input.transaction.provider ?? "").toUpperCase()} ` +
          `has been reversed. Reason: ${input.reason}` +
          (input.reversalReference ? ` Reference: ${input.reversalReference}.` : "."),
        dedupKey: `reversal:${input.reversalId}`,
        data: {
          reversalId: input.reversalId,
          reversalReference: input.reversalReference,
          originalReference: input.transaction.referenceNumber,
          reason: input.reason,
        },
      });
      return true;
    } catch (error) {
      logger.warn(
        { error, reversalId: input.reversalId },
        "[tx-reversal] reversal notification failed",
      );
      return false;
    }
  }

  /**
   * Re-deliver the notification for a reversal that was posted but never
   * announced (e.g. the notification worker was down at the time).
   */
  async retryNotification(reversalId: string): Promise<boolean> {
    const record = await this.getReversal(reversalId);
    if (!record) return false;
    if (record.status !== "posted" && record.status !== "notified") {
      return false;
    }

    const transaction = await this.transactionModel.findById(record.transactionId);
    if (!transaction) return false;

    const delivered = await this.notifyReversal({
      transaction,
      reason: record.reason,
      reversalReference: record.reversalReference,
      reversalId: record.id,
    });

    if (delivered && record.status === "posted") {
      await this.transition(record.id, "notified", null, { retried: true });
    }
    return delivered;
  }

  /** Reversals still waiting for their notification to be delivered. */
  async findUnnotifiedReversals(limit = 50): Promise<ReversalRecord[]> {
    if (!this.persist) return [];

    const { rows } = await queryRead<any>(
      `SELECT ${REVERSAL_COLUMNS} FROM transaction_reversals
        WHERE status = 'posted' AND notified_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map(mapReversalRow);
  }
}

/** Terminal states cannot be left. */
function isTerminal(status: ReversalStatus): boolean {
  return status === "notified" || status === "failed";
}

export const transactionReversalService = new TransactionReversalService();
