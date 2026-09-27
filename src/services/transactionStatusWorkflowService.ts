import logger from "../utils/logger";
import { TransactionStatus } from "../models/transaction";

export type DetailedStatus =
  | "INITIATED"
  | "KYC_VERIFYING"
  | "AML_CHECKING"
  | "FUNDS_RESERVED"
  | "SUBMITTED_TO_PROVIDER"
  | "PROVIDER_PROCESSING"
  | "AWAITING_CONFIRMATION"
  | "COMPLETED"
  | "FAILED"
  | "REVERSED"
  | "REFUNDED"
  | "FLAGGED_FOR_REVIEW";

export interface StatusHistoryEntry {
  fromStatus?: DetailedStatus;
  toStatus: DetailedStatus;
  reason?: string;
  explanation: string;
  updatedBy: string;
  timestamp: Date;
}

export class TransactionStatusWorkflowService {
  private static readonly VALID_TRANSITIONS: Record<DetailedStatus, DetailedStatus[]> = {
    INITIATED: ["KYC_VERIFYING", "AML_CHECKING", "FLAGGED_FOR_REVIEW", "FAILED"],
    KYC_VERIFYING: ["AML_CHECKING", "FLAGGED_FOR_REVIEW", "FAILED"],
    AML_CHECKING: ["FUNDS_RESERVED", "FLAGGED_FOR_REVIEW", "FAILED"],
    FUNDS_RESERVED: ["SUBMITTED_TO_PROVIDER", "FAILED"],
    SUBMITTED_TO_PROVIDER: ["PROVIDER_PROCESSING", "FAILED"],
    PROVIDER_PROCESSING: ["AWAITING_CONFIRMATION", "COMPLETED", "FAILED"],
    AWAITING_CONFIRMATION: ["COMPLETED", "FAILED"],
    COMPLETED: ["REVERSED", "REFUNDED"],
    FAILED: [],
    REVERSED: [],
    REFUNDED: [],
    FLAGGED_FOR_REVIEW: ["INITIATED", "FUNDS_RESERVED", "FAILED"],
  };

  private static readonly EXPLANATIONS: Record<DetailedStatus, string> = {
    INITIATED: "Transaction initiated by user or merchant.",
    KYC_VERIFYING: "Identity verification is actively being verified.",
    AML_CHECKING: "Anti-Money Laundering screening and sanction checks in progress.",
    FUNDS_RESERVED: "Customer funds have been secured and locked for processing.",
    SUBMITTED_TO_PROVIDER: "Transfer payload sent to external banking or Stellar network gateway.",
    PROVIDER_PROCESSING: "External network provider is clearing the transaction.",
    AWAITING_CONFIRMATION: "Transaction executed; waiting for blockchain ledger or clearing house finality.",
    COMPLETED: "Transaction successfully settled and confirmed.",
    FAILED: "Transaction terminated due to an error, timeout, or policy rejection.",
    REVERSED: "Transaction settlement has been rolled back and reversed.",
    REFUNDED: "Funds returned to original funding account.",
    FLAGGED_FOR_REVIEW: "High-risk signals detected; transaction placed in manual review queue.",
  };

  private histories: Map<string, StatusHistoryEntry[]> = new Map();

  /**
   * Validate if a transition between two statuses is allowed.
   */
  public isValidTransition(current: DetailedStatus, next: DetailedStatus): boolean {
    const allowed = TransactionStatusWorkflowService.VALID_TRANSITIONS[current] || [];
    return allowed.includes(next);
  }

  /**
   * Transition transaction status, recording detailed history and explanations.
   */
  public transition(
    txId: string,
    current: DetailedStatus,
    next: DetailedStatus,
    updatedBy: string = "system",
    reason?: string
  ): StatusHistoryEntry {
    if (!this.isValidTransition(current, next)) {
      const msg = `Invalid state transition from ${current} to ${next} for transaction ${txId}`;
      logger.error(`[StatusWorkflow] ${msg}`);
      throw new Error(msg);
    }

    const explanation = TransactionStatusWorkflowService.EXPLANATIONS[next];
    const entry: StatusHistoryEntry = {
      fromStatus: current,
      toStatus: next,
      reason,
      explanation,
      updatedBy,
      timestamp: new Date(),
    };

    const history = this.histories.get(txId) || [];
    history.push(entry);
    this.histories.set(txId, history);

    logger.info(`[StatusWorkflow] Transaction ${txId} transitioned: ${current} -> ${next} (${explanation})`);
    return entry;
  }

  /**
   * Get complete status history and explanation timeline for a transaction.
   */
  public getHistory(txId: string): StatusHistoryEntry[] {
    return [...(this.histories.get(txId) || [])];
  }

  /**
   * Get human-readable explanation for a given status.
   */
  public getStatusExplanation(status: DetailedStatus): string {
    return TransactionStatusWorkflowService.EXPLANATIONS[status] || "Status updated.";
  }
}

export const transactionStatusWorkflowService = new TransactionStatusWorkflowService();
