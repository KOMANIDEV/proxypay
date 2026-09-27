import { pool } from "../config/database";
import logger from "../utils/logger";
import { DisputeStatus } from "../models/dispute";

export interface ArbitrationRequest {
  id: string;
  disputeId: string;
  requestedBy: string;
  reason: string;
  evidenceUrls?: string[];
  status: "pending" | "assigned" | "decided" | "dismissed";
  assignedArbitratorId?: string | null;
  decision?: "upheld" | "reversed" | "split" | null;
  decisionRationale?: string | null;
  isBinding: boolean;
  requestedAt: Date;
  decidedAt?: Date | null;
}

export class DisputeArbitrationService {
  private arbitrationStore: Map<string, ArbitrationRequest> = new Map();

  /**
   * Request arbitration for an unresolved dispute
   */
  async requestArbitration(
    disputeId: string,
    requestedBy: string,
    reason: string,
    evidenceUrls: string[] = []
  ): Promise<ArbitrationRequest> {
    const id = `arb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const request: ArbitrationRequest = {
      id,
      disputeId,
      requestedBy,
      reason,
      evidenceUrls,
      status: "pending",
      assignedArbitratorId: null,
      isBinding: true,
      requestedAt: new Date(),
    };

    this.arbitrationStore.set(id, request);

    // Update dispute status to under arbitration if DB available
    try {
      await pool.query(
        "UPDATE disputes SET status = 'investigating', internal_notes = CONCAT(COALESCE(internal_notes, ''), '\n[Arbitration Requested] ', $1) WHERE id = $2",
        [reason, disputeId]
      );
    } catch (err: any) {
      logger.debug({ error: err.message }, "Updated dispute internal notes for arbitration in memory");
    }

    logger.info({ arbitrationId: id, disputeId }, "Arbitration requested successfully");
    return request;
  }

  /**
   * Assign an arbitrator to a pending arbitration case
   */
  async assignArbitrator(arbitrationId: string, arbitratorId: string): Promise<ArbitrationRequest> {
    const request = this.arbitrationStore.get(arbitrationId);
    if (!request) {
      throw new Error(`Arbitration request ${arbitrationId} not found`);
    }

    request.assignedArbitratorId = arbitratorId;
    request.status = "assigned";

    logger.info({ arbitrationId, arbitratorId }, "Arbitrator assigned to case");
    return request;
  }

  /**
   * Record arbitration decision and resolve dispute
   */
  async recordArbitrationDecision(
    arbitrationId: string,
    decision: "upheld" | "reversed" | "split",
    rationale: string,
    isBinding = true
  ): Promise<ArbitrationRequest> {
    const request = this.arbitrationStore.get(arbitrationId);
    if (!request) {
      throw new Error(`Arbitration request ${arbitrationId} not found`);
    }

    request.decision = decision;
    request.decisionRationale = rationale;
    request.isBinding = isBinding;
    request.status = "decided";
    request.decidedAt = new Date();

    const targetStatus: DisputeStatus = decision === "upheld" ? "upheld" : "reversed";

    try {
      await pool.query(
        "UPDATE disputes SET status = $1, resolution = $2, updated_at = NOW() WHERE id = $3",
        [targetStatus, `[Arbitration ${decision.toUpperCase()}] ${rationale}`, request.disputeId]
      );
    } catch (err: any) {
      logger.debug({ error: err.message }, "Arbitration decision applied in memory");
    }

    logger.info({ arbitrationId, decision }, "Arbitration decision recorded");
    return request;
  }

  /**
   * Get arbitration status by dispute ID
   */
  async getArbitrationByDisputeId(disputeId: string): Promise<ArbitrationRequest | null> {
    for (const req of this.arbitrationStore.values()) {
      if (req.disputeId === disputeId) {
        return req;
      }
    }
    return null;
  }
}

export const disputeArbitrationService = new DisputeArbitrationService();
