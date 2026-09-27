/**
 * GraphQL Subscription — Settlement Status
 *
 * Exposes a `settlementStatusUpdated` subscription that streams real-time
 * stage progression events for a specific transaction.
 *
 * Pattern mirrors the existing subscriptionResolvers.ts factory function:
 *   - Authenticated via context.auth
 *   - Per-transaction Redis channel  `SETTLEMENT_STATUS_UPDATED:<id>`
 *   - Broad channel for admin dashboards
 *
 * Issue #411 — Real-Time Transaction Settlement Status
 */

import { withFilter } from "graphql-subscriptions";
import {
  type TypedPubSub,
  SubscriptionChannels,
} from "../subscriptions";
import type { SettlementStatusPayload } from "../../services/settlementStatus";
import { SettlementStage } from "../../services/settlementStatus";

// ---------------------------------------------------------------------------
// Channel helpers
// ---------------------------------------------------------------------------

export const SETTLEMENT_STATUS_CHANNEL = "SETTLEMENT_STATUS_UPDATED";

export function settlementStatusChannel(transactionId: string): string {
  return `${SETTLEMENT_STATUS_CHANNEL}:${transactionId}`;
}

// ---------------------------------------------------------------------------
// Payload formatter
// ---------------------------------------------------------------------------

function formatSettlementPayload(payload: SettlementStatusPayload) {
  return {
    transactionId: payload.transactionId,
    stage: payload.stage,
    previousStage: payload.previousStage ?? null,
    progressPercent: payload.progressPercent,
    isTerminal: payload.isTerminal,
    metadata: payload.metadata,
    occurredAt: payload.occurredAt,
  };
}

// ---------------------------------------------------------------------------
// Resolver factory — matches the pattern in subscriptionResolvers.ts
// ---------------------------------------------------------------------------

export function createSettlementStatusResolvers(pubsub: TypedPubSub) {
  return {
    Subscription: {
      /**
       * `settlementStatusUpdated(transactionId: ID!)` — subscribe to all
       * stage changes for a specific transaction.
       *
       * Uses a dedicated per-transaction channel so the server only fans out
       * to clients that care about this transaction (no withFilter needed).
       */
      settlementStatusUpdated: {
        subscribe: (
          _parent: unknown,
          args: { transactionId: string },
          context: any,
        ) => {
          if (!context?.auth?.authenticated) {
            throw new Error("UNAUTHENTICATED: valid authToken required");
          }
          if (!args.transactionId) {
            throw new Error(
              "settlementStatusUpdated requires a transactionId argument",
            );
          }
          return pubsub.asyncIterator<SettlementStatusPayload>(
            settlementStatusChannel(args.transactionId),
          );
        },
        resolve: (payload: SettlementStatusPayload) =>
          formatSettlementPayload(payload),
      },

      /**
       * `allSettlementUpdates` — admin / dashboard subscription that receives
       * every settlement stage change across all transactions.  Optionally
       * filtered by stage.
       */
      allSettlementUpdates: {
        subscribe: withFilter(
          (_parent: unknown, _args: unknown, context: any) => {
            if (!context?.auth?.authenticated) {
              throw new Error("UNAUTHENTICATED: valid authToken required");
            }
            // Reuse the TRANSACTION_UPDATED broad channel — the service
            // publishes a compatible payload on it.
            return pubsub.asyncIterator<SettlementStatusPayload>(
              SETTLEMENT_STATUS_CHANNEL,
            );
          },
          (payload: SettlementStatusPayload, variables: { stage?: string }) => {
            if (!variables?.stage) return true;
            return payload.stage === variables.stage;
          },
        ),
        resolve: (payload: SettlementStatusPayload) =>
          formatSettlementPayload(payload),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Re-export types for convenience
// ---------------------------------------------------------------------------
export { SettlementStage };
export type { SettlementStatusPayload };
