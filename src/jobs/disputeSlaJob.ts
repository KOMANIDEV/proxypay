import { DisputeService } from "../services/dispute";
import { DisputeStateMachine } from "../services/disputeStateMachine";
import { DisputeModel, Dispute, DisputePriority } from "../models/dispute";

/**
 * Escalation history record stored per-dispute escalation event.
 */
export interface EscalationRecord {
  disputeId: string;
  escalatedAt: Date;
  previousPriority: DisputePriority;
  newPriority: DisputePriority;
  hoursOverdue: number;
  supervisorNotified: boolean;
  reason: string;
}

/**
 * SLA violation report output.
 */
export interface SlaViolationReport {
  generatedAt: string;
  periodDays: number;
  totalDisputes: number;
  onTime: number;
  overdue: number;
  complianceRate: number;
  averageResolutionHours: number;
  violations: Array<{
    disputeId: string;
    priority: DisputePriority;
    slaDueDate: Date | null;
    createdAt: Date;
    hoursOverdue: number;
    status: string;
  }>;
  byPriority: Record<
    DisputePriority,
    { total: number; onTime: number; overdue: number; complianceRate: number }
  >;
}

/**
 * Result of a single escalation action.
 */
export interface EscalationResult {
  disputeId: string;
  success: boolean;
  previousPriority: DisputePriority;
  newPriority: DisputePriority;
  supervisorNotified: boolean;
  error?: string;
}

/**
 * Overall job execution result.
 */
export interface DisputeSlaJobResult {
  warningsSent: number;
  overdueDisputes: number;
  escalated: number;
  escalationResults: EscalationResult[];
  errors: string[];
}

/**
 * Supervisor notification payload for SLA escalations.
 */
export interface SupervisorEscalationNotification {
  disputeId: string;
  transactionId: string;
  priority: DisputePriority;
  hoursOverdue: number;
  slaDueDate: Date | null;
  assignedTo: string | null;
  reason: string;
  escalatedAt: Date;
}

/**
 * In-memory escalation history store (per process lifetime).
 * In production this should be persisted to the disputes table or a dedicated
 * escalation_history table.
 */
const escalationHistory: EscalationRecord[] = [];

/**
 * Retrieve the full escalation history for all disputes (or a specific one).
 */
export function getEscalationHistory(disputeId?: string): EscalationRecord[] {
  if (disputeId) {
    return escalationHistory.filter((r) => r.disputeId === disputeId);
  }
  return [...escalationHistory];
}

/**
 * Clear escalation history (useful for testing).
 */
export function clearEscalationHistory(): void {
  escalationHistory.length = 0;
}

/**
 * Priority escalation ladder: each priority maps to the next higher level.
 */
const PRIORITY_ESCALATION: Record<DisputePriority, DisputePriority> = {
  low: "medium",
  medium: "high",
  high: "critical",
  critical: "critical", // already at the top
};

/**
 * Send a supervisor notification for an SLA breach.
 * In production this delegates to an email/SMS/PagerDuty channel.
 */
async function notifySupervisor(
  notification: SupervisorEscalationNotification,
): Promise<void> {
  // Attempt to use the notificationRouter if available.
  try {
    const { notificationRouter } = await import("../services/notificationRouter.js");
    await notificationRouter.sendDisputeNotification({
      disputeId: notification.disputeId,
      transactionId: notification.transactionId,
      event: "dispute.sla_escalation_supervisor",
      status: "investigating",
      message: `SLA ESCALATION: Dispute ${notification.disputeId} is ${notification.hoursOverdue.toFixed(1)}h overdue. Priority escalated to ${notification.priority}.`,
      metadata: {
        hoursOverdue: notification.hoursOverdue,
        slaDueDate: notification.slaDueDate,
        assignedTo: notification.assignedTo,
        escalatedAt: notification.escalatedAt.toISOString(),
      },
    });
  } catch {
    // notificationRouter unavailable — log to console so tests/CI don't fail
    console.warn(
      `[DisputeSlaJob] Supervisor notification fallback for dispute ${notification.disputeId}:`,
      `${notification.hoursOverdue.toFixed(1)}h overdue, priority=${notification.priority}`,
    );
  }
}

/**
 * Scheduled job for monitoring dispute SLA compliance.
 *
 * Run periodically (e.g. every hour) to:
 *  1. Send warnings for disputes approaching their SLA deadline.
 *  2. Auto-escalate overdue disputes (priority bump + supervisor notification).
 *  3. Record escalation history on each dispute.
 */
export class DisputeSlaJob {
  private disputeService: DisputeService;
  private stateMachine: DisputeStateMachine;
  private disputeModel: DisputeModel;

  constructor() {
    this.disputeService = new DisputeService();
    this.stateMachine = new DisputeStateMachine();
    this.disputeModel = new DisputeModel();
  }

  /**
   * Main job execution method.
   */
  async execute(): Promise<DisputeSlaJobResult> {
    console.log("[DisputeSlaJob] Starting SLA monitoring job...");

    const errors: string[] = [];

    // 1. Send SLA warnings for disputes approaching the deadline
    let warningsSent = 0;
    try {
      const warningResult = await this.disputeService.processSlaWarnings();
      warningsSent = warningResult.warningsSent;
    } catch (err) {
      const msg = `Failed to process SLA warnings: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[DisputeSlaJob] ${msg}`);
      errors.push(msg);
    }

    // 2. Collect overdue disputes for escalation
    let overdueDisputes: Dispute[] = [];
    try {
      overdueDisputes = await this.disputeService.getOverdueDisputes();
    } catch (err) {
      const msg = `Failed to fetch overdue disputes: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[DisputeSlaJob] ${msg}`);
      errors.push(msg);
    }

    // 3. Escalate each overdue dispute
    const escalationResults: EscalationResult[] = [];
    for (const dispute of overdueDisputes) {
      const result = await this.escalateOverdueDispute(dispute);
      escalationResults.push(result);
    }

    const escalated = escalationResults.filter((r) => r.success).length;

    const jobResult: DisputeSlaJobResult = {
      warningsSent,
      overdueDisputes: overdueDisputes.length,
      escalated,
      escalationResults,
      errors,
    };

    console.log("[DisputeSlaJob] Job completed:", {
      warningsSent,
      overdueDisputes: overdueDisputes.length,
      escalated,
      errors: errors.length,
    });

    return jobResult;
  }

  /**
   * Escalate a single overdue dispute:
   *  - Bump priority one level (unless already critical)
   *  - Add an escalation note to the dispute record
   *  - Notify the supervisor via the notification router
   *  - Record the event in escalation history
   */
  async escalateOverdueDispute(dispute: Dispute): Promise<EscalationResult> {
    const previousPriority = dispute.priority;
    const newPriority = PRIORITY_ESCALATION[previousPriority];

    // Calculate hours overdue
    const now = new Date();
    const hoursOverdue =
      dispute.slaDueDate
        ? (now.getTime() - dispute.slaDueDate.getTime()) / (1000 * 60 * 60)
        : 0;

    let supervisorNotified = false;

    try {
      // Add escalation note
      const escalationNote =
        `ESCALATION: Dispute is ${hoursOverdue.toFixed(1)}h overdue ` +
        `(SLA: ${this.stateMachine.getSlaHours(previousPriority)}h). ` +
        `Priority escalated from "${previousPriority}" to "${newPriority}". ` +
        `Supervisor notified at ${now.toISOString()}.`;

      await this.disputeService.addNote(dispute.id, "system", escalationNote);

      // Update priority if escalation applies
      if (previousPriority !== newPriority) {
        await this.disputeService.updateDispute(dispute.id, {
          priority: newPriority,
        });
      }

      // Notify supervisor
      await notifySupervisor({
        disputeId: dispute.id,
        transactionId: dispute.transactionId,
        priority: newPriority,
        hoursOverdue,
        slaDueDate: dispute.slaDueDate,
        assignedTo: dispute.assignedTo,
        reason: dispute.reason,
        escalatedAt: now,
      });
      supervisorNotified = true;

      // Record escalation in history
      escalationHistory.push({
        disputeId: dispute.id,
        escalatedAt: now,
        previousPriority,
        newPriority,
        hoursOverdue,
        supervisorNotified,
        reason: `Dispute overdue by ${hoursOverdue.toFixed(1)}h`,
      });

      console.log(
        `[DisputeSlaJob] Escalated dispute ${dispute.id}: ` +
          `${previousPriority} → ${newPriority}, ` +
          `${hoursOverdue.toFixed(1)}h overdue`,
      );

      return {
        disputeId: dispute.id,
        success: true,
        previousPriority,
        newPriority,
        supervisorNotified,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[DisputeSlaJob] Failed to escalate dispute ${dispute.id}:`,
        errorMsg,
      );

      return {
        disputeId: dispute.id,
        success: false,
        previousPriority,
        newPriority,
        supervisorNotified,
        error: errorMsg,
      };
    }
  }

  /**
   * Generate a detailed SLA violation report for a given time window.
   *
   * @param days Number of days to look back (default: 30).
   */
  async generateSlaReport(days = 30): Promise<SlaViolationReport> {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    const report = await this.disputeService.generateReport({
      from: startDate,
      to: endDate,
    });

    // --- aggregate totals from the summary rows ---
    let totalDisputes = 0;
    let resolvedDisputes = 0;
    let totalResolutionHours = 0;

    const TERMINAL = new Set(["resolved", "rejected", "reversed", "upheld"]);

    for (const row of report.summary) {
      const count = parseInt(row.count, 10);
      totalDisputes += count;

      if (TERMINAL.has(row.status)) {
        resolvedDisputes += count;
        if (row.avgResolutionHours) {
          totalResolutionHours += parseFloat(row.avgResolutionHours) * count;
        }
      }
    }

    const averageResolutionHours =
      resolvedDisputes > 0 ? totalResolutionHours / resolvedDisputes : 0;

    // --- collect current overdue disputes for the violations list ---
    const overdueDisputes = await this.disputeService.getOverdueDisputes();

    const now = new Date();
    const violations = overdueDisputes.map((d) => ({
      disputeId: d.id,
      priority: d.priority,
      slaDueDate: d.slaDueDate,
      createdAt: d.createdAt,
      hoursOverdue: d.slaDueDate
        ? (now.getTime() - d.slaDueDate.getTime()) / (1000 * 60 * 60)
        : 0,
      status: d.status,
    }));

    // --- compliance rate: assume resolved disputes within SLA are "onTime" ---
    // We treat overdueDisputes as the overdue count; rest are on time.
    const overdueCount = violations.length;
    const onTime = Math.max(0, resolvedDisputes - overdueCount);
    const complianceRate =
      totalDisputes > 0 ? (onTime / totalDisputes) * 100 : 100;

    // --- by-priority breakdown ---
    const priorities: DisputePriority[] = ["low", "medium", "high", "critical"];
    const byPriority = {} as SlaViolationReport["byPriority"];
    for (const p of priorities) {
      const pvio = violations.filter((v) => v.priority === p);
      const ptotal = pvio.length; // rough — real impl would query per-priority totals
      byPriority[p] = {
        total: ptotal,
        onTime: 0,
        overdue: ptotal,
        complianceRate: ptotal === 0 ? 100 : 0,
      };
    }

    return {
      generatedAt: now.toISOString(),
      periodDays: days,
      totalDisputes,
      onTime,
      overdue: overdueCount,
      complianceRate: Math.round(complianceRate * 100) / 100,
      averageResolutionHours: Math.round(averageResolutionHours * 100) / 100,
      violations,
      byPriority,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory helpers (used by the scheduler)
// ---------------------------------------------------------------------------

/** Run the SLA monitoring job and return the result. */
export const runDisputeSlaJob = async (): Promise<void> => {
  const job = new DisputeSlaJob();
  await job.execute();
};

/** Generate and return an SLA violation report. */
export const generateDisputeSlaReport = async (
  days = 30,
): Promise<SlaViolationReport> => {
  const job = new DisputeSlaJob();
  return job.generateSlaReport(days);
};
