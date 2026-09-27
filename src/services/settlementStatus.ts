/**
 * Settlement Status Service
 *
 * Tracks the fine-grained progression of a transaction through all settlement
 * stages, from mobile-money initiation through Stellar finality to destination
 * payout.  Publishes stage-change events to the GraphQL subscription bus and
 * to the WebSocket layer so all connected clients receive live updates.
 *
 * Issue #411 — Real-Time Transaction Settlement Status
 */

import { queryRead, queryWrite } from "../config/database";
import { pubsub, SubscriptionChannels } from "../graphql/subscriptions";
import { WebSocketManager } from "../websocket/websocketManager";

// ---------------------------------------------------------------------------
// Enums & Types
// ---------------------------------------------------------------------------

/**
 * All discrete stages a transaction passes through during settlement.
 * Ordered from earliest to latest; not every transaction visits every stage
 * (e.g. deposit vs withdraw have different paths).
 */
export enum SettlementStage {
  /** Transaction record created; awaiting provider confirmation. */
  INITIATED = "INITIATED",
  /** Mobile-money provider has accepted the request. */
  PROVIDER_ACCEPTED = "PROVIDER_ACCEPTED",
  /** Mobile-money payment confirmed by provider. */
  MOBILE_MONEY_CONFIRMED = "MOBILE_MONEY_CONFIRMED",
  /** Stellar transaction submitted to the network. */
  STELLAR_SUBMITTED = "STELLAR_SUBMITTED",
  /** Stellar transaction confirmed on-ledger (one close). */
  STELLAR_CONFIRMED = "STELLAR_CONFIRMED",
  /** Payout to destination mobile wallet triggered. */
  PAYOUT_INITIATED = "PAYOUT_INITIATED",
  /** Destination mobile wallet credited; settlement complete. */
  COMPLETED = "COMPLETED",
  /** Settlement failed at some stage. */
  FAILED = "FAILED",
  /** Settlement cancelled before finalisation. */
  CANCELLED = "CANCELLED",
}

export const STAGE_ORDER: SettlementStage[] = [
  SettlementStage.INITIATED,
  SettlementStage.PROVIDER_ACCEPTED,
  SettlementStage.MOBILE_MONEY_CONFIRMED,
  SettlementStage.STELLAR_SUBMITTED,
  SettlementStage.STELLAR_CONFIRMED,
  SettlementStage.PAYOUT_INITIATED,
  SettlementStage.COMPLETED,
];

const TERMINAL_STAGES = new Set<SettlementStage>([
  SettlementStage.COMPLETED,
  SettlementStage.FAILED,
  SettlementStage.CANCELLED,
]);

export interface SettlementStatusRecord {
  transactionId: string;
  stage: SettlementStage;
  previousStage: SettlementStage | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface SettlementStatusPayload {
  transactionId: string;
  stage: SettlementStage;
  previousStage: SettlementStage | null;
  progressPercent: number;
  isTerminal: boolean;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Progress calculation
// ---------------------------------------------------------------------------

export function stageProgressPercent(stage: SettlementStage): number {
  if (stage === SettlementStage.FAILED || stage === SettlementStage.CANCELLED) {
    return 0;
  }
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / STAGE_ORDER.length) * 100);
}

export function isValidStageTransition(
  from: SettlementStage | null,
  to: SettlementStage,
): boolean {
  if (TERMINAL_STAGES.has(from as SettlementStage)) return false;
  if (to === SettlementStage.FAILED || to === SettlementStage.CANCELLED) {
    return true; // any non-terminal stage can move to failed/cancelled
  }
  if (from === null) return to === SettlementStage.INITIATED;

  const fromIdx = STAGE_ORDER.indexOf(from);
  const toIdx = STAGE_ORDER.indexOf(to);
  return toIdx === fromIdx + 1;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function persistStageTransition(
  record: SettlementStatusRecord,
): Promise<void> {
  await queryWrite(
    `INSERT INTO settlement_status_log
       (transaction_id, stage, previous_stage, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      record.transactionId,
      record.stage,
      record.previousStage,
      JSON.stringify(record.metadata),
      record.occurredAt,
    ],
  );

  // Keep the transactions table in sync
  await queryWrite(
    `UPDATE transactions
        SET settlement_stage = $2,
            updated_at        = NOW()
      WHERE id = $1`,
    [record.transactionId, record.stage],
  );
}

async function fetchCurrentStage(
  transactionId: string,
): Promise<SettlementStage | null> {
  const result = await queryRead<{ settlement_stage: string | null }>(
    `SELECT settlement_stage FROM transactions WHERE id = $1`,
    [transactionId],
  );
  const raw = result.rows[0]?.settlement_stage;
  if (!raw) return null;
  return raw as SettlementStage;
}

export async function getSettlementHistory(
  transactionId: string,
): Promise<SettlementStatusRecord[]> {
  const result = await queryRead<{
    transaction_id: string;
    stage: string;
    previous_stage: string | null;
    metadata: Record<string, unknown>;
    occurred_at: Date;
  }>(
    `SELECT transaction_id, stage, previous_stage, metadata, occurred_at
       FROM settlement_status_log
      WHERE transaction_id = $1
      ORDER BY occurred_at ASC`,
    [transactionId],
  );

  return result.rows.map((row) => ({
    transactionId: row.transaction_id,
    stage: row.stage as SettlementStage,
    previousStage: row.previous_stage as SettlementStage | null,
    metadata: row.metadata ?? {},
    occurredAt: row.occurred_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Publishing helpers
// ---------------------------------------------------------------------------

async function publishToGraphQL(
  payload: SettlementStatusPayload,
): Promise<void> {
  // Publish on the per-transaction channel (same pattern as transactionUpdated)
  await pubsub.publish(
    `SETTLEMENT_STATUS_UPDATED:${payload.transactionId}`,
    payload,
  );
  // Also publish on the broad channel for dashboards
  await pubsub.publish(SubscriptionChannels.TRANSACTION_UPDATED, {
    id: payload.transactionId,
    referenceNumber: "",
    status: payload.stage,
    updatedAt: payload.occurredAt,
    settlementStage: payload.stage,
    progressPercent: payload.progressPercent,
  });
}

function publishToWebSocket(
  payload: SettlementStatusPayload,
  userId?: string,
): void {
  const wsManager = WebSocketManager.getInstance();
  if (!wsManager) return;

  wsManager
    .broadcastTransactionUpdate({
      id: payload.transactionId,
      status: payload.stage,
      userId: userId ?? null,
      settlementStage: payload.stage,
      progressPercent: payload.progressPercent,
      isTerminal: payload.isTerminal,
      occurredAt: payload.occurredAt,
    })
    .catch((err) =>
      console.warn(
        `[settlement-status] WS broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
}

// ---------------------------------------------------------------------------
// Main service class
// ---------------------------------------------------------------------------

export class SettlementStatusService {
  /**
   * Advance a transaction to the given settlement stage.
   *
   * Validates the transition, persists the change, then pushes real-time
   * notifications to all subscribers (GraphQL + WebSocket).
   *
   * @param transactionId - UUID of the transaction
   * @param stage         - Target stage
   * @param metadata      - Optional contextual data (e.g. tx hash, error msg)
   * @param userId        - Owner's userId for WebSocket room targeting
   */
  async advanceStage(
    transactionId: string,
    stage: SettlementStage,
    metadata: Record<string, unknown> = {},
    userId?: string,
  ): Promise<SettlementStatusPayload> {
    const currentStage = await fetchCurrentStage(transactionId);

    if (!isValidStageTransition(currentStage, stage)) {
      throw new Error(
        `Invalid stage transition: ${currentStage ?? "null"} → ${stage}`,
      );
    }

    const occurredAt = new Date().toISOString();
    const record: SettlementStatusRecord = {
      transactionId,
      stage,
      previousStage: currentStage,
      metadata,
      occurredAt,
    };

    await persistStageTransition(record);

    const payload: SettlementStatusPayload = {
      transactionId,
      stage,
      previousStage: currentStage,
      progressPercent: stageProgressPercent(stage),
      isTerminal: TERMINAL_STAGES.has(stage),
      metadata,
      occurredAt,
    };

    // Fire-and-forget publishing — don't let pubsub errors block callers
    publishToGraphQL(payload).catch((err) =>
      console.warn(
        `[settlement-status] GraphQL publish failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    publishToWebSocket(payload, userId);

    return payload;
  }

  /**
   * Retrieve the current settlement stage for a transaction.
   */
  async getCurrentStage(
    transactionId: string,
  ): Promise<SettlementStage | null> {
    return fetchCurrentStage(transactionId);
  }

  /**
   * Retrieve the full audit log of stage transitions.
   */
  async getHistory(
    transactionId: string,
  ): Promise<SettlementStatusRecord[]> {
    return getSettlementHistory(transactionId);
  }
}

export const settlementStatusService = new SettlementStatusService();
