import {
  DisputeSlaJob,
  EscalationRecord,
  EscalationResult,
  clearEscalationHistory,
  getEscalationHistory,
  runDisputeSlaJob,
  generateDisputeSlaReport,
} from "../../src/jobs/disputeSlaJob";
import { DisputeService } from "../../src/services/dispute";
import { DisputeModel, Dispute, DisputePriority } from "../../src/models/dispute";
import { DisputeStateMachine } from "../../src/services/disputeStateMachine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeDispute = (overrides: Partial<Dispute> = {}): Dispute => ({
  id: "dispute-1",
  transactionId: "txn-1",
  reason: "wrong amount",
  status: "open",
  assignedTo: null,
  resolution: null,
  reportedBy: "user-1",
  priority: "medium" as DisputePriority,
  category: null,
  slaDueDate: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours overdue
  slaWarningSent: false,
  internalNotes: null,
  createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
  updatedAt: new Date(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DisputeSlaJob", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    clearEscalationHistory();
  });

  // -------------------------------------------------------------------------
  // execute()
  // -------------------------------------------------------------------------

  describe("execute()", () => {
    it("returns zeroed result when no overdue disputes exist", async () => {
      jest
        .spyOn(DisputeService.prototype, "processSlaWarnings")
        .mockResolvedValue({ warningsSent: 0 });
      jest
        .spyOn(DisputeService.prototype, "getOverdueDisputes")
        .mockResolvedValue([]);

      const job = new DisputeSlaJob();
      const result = await job.execute();

      expect(result.warningsSent).toBe(0);
      expect(result.overdueDisputes).toBe(0);
      expect(result.escalated).toBe(0);
      expect(result.escalationResults).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("processes SLA warnings and escalates overdue disputes", async () => {
      const dispute = makeDispute();

      jest
        .spyOn(DisputeService.prototype, "processSlaWarnings")
        .mockResolvedValue({ warningsSent: 3 });
      jest
        .spyOn(DisputeService.prototype, "getOverdueDisputes")
        .mockResolvedValue([dispute]);
      jest
        .spyOn(DisputeService.prototype, "addNote")
        .mockResolvedValue({
          id: "note-1",
          disputeId: dispute.id,
          author: "system",
          note: "escalation note",
          createdAt: new Date(),
        });
      jest
        .spyOn(DisputeService.prototype, "updateDispute")
        .mockResolvedValue({ ...dispute, priority: "high" });

      const job = new DisputeSlaJob();
      const result = await job.execute();

      expect(result.warningsSent).toBe(3);
      expect(result.overdueDisputes).toBe(1);
      expect(result.escalated).toBe(1);
      expect(result.escalationResults).toHaveLength(1);
      expect(result.escalationResults[0].disputeId).toBe(dispute.id);
      expect(result.escalationResults[0].success).toBe(true);
      expect(result.escalationResults[0].previousPriority).toBe("medium");
      expect(result.escalationResults[0].newPriority).toBe("high");
    });

    it("records errors but continues when SLA warnings fail", async () => {
      jest
        .spyOn(DisputeService.prototype, "processSlaWarnings")
        .mockRejectedValue(new Error("DB error"));
      jest
        .spyOn(DisputeService.prototype, "getOverdueDisputes")
        .mockResolvedValue([]);

      const job = new DisputeSlaJob();
      const result = await job.execute();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("DB error");
      expect(result.escalated).toBe(0);
    });

    it("records errors but continues when fetching overdue disputes fails", async () => {
      jest
        .spyOn(DisputeService.prototype, "processSlaWarnings")
        .mockResolvedValue({ warningsSent: 0 });
      jest
        .spyOn(DisputeService.prototype, "getOverdueDisputes")
        .mockRejectedValue(new Error("timeout"));

      const job = new DisputeSlaJob();
      const result = await job.execute();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("timeout");
    });
  });

  // -------------------------------------------------------------------------
  // escalateOverdueDispute()
  // -------------------------------------------------------------------------

  describe("escalateOverdueDispute()", () => {
    it("escalates low → medium", async () => {
      const dispute = makeDispute({ priority: "low" });
      jest.spyOn(DisputeService.prototype, "addNote").mockResolvedValue({
        id: "note-1",
        disputeId: dispute.id,
        author: "system",
        note: "",
        createdAt: new Date(),
      });
      jest.spyOn(DisputeService.prototype, "updateDispute").mockResolvedValue({
        ...dispute,
        priority: "medium",
      });

      const job = new DisputeSlaJob();
      const result = await job.escalateOverdueDispute(dispute);

      expect(result.success).toBe(true);
      expect(result.previousPriority).toBe("low");
      expect(result.newPriority).toBe("medium");
    });

    it("escalates medium → high", async () => {
      const dispute = makeDispute({ priority: "medium" });
      jest.spyOn(DisputeService.prototype, "addNote").mockResolvedValue({
        id: "note-1",
        disputeId: dispute.id,
        author: "system",
        note: "",
        createdAt: new Date(),
      });
      jest.spyOn(DisputeService.prototype, "updateDispute").mockResolvedValue({
        ...dispute,
        priority: "high",
      });

      const job = new DisputeSlaJob();
      const result = await job.escalateOverdueDispute(dispute);

      expect(result.previousPriority).toBe("medium");
      expect(result.newPriority).toBe("high");
    });

    it("escalates high → critical", async () => {
      const dispute = makeDispute({ priority: "high" });
      jest.spyOn(DisputeService.prototype, "addNote").mockResolvedValue({
        id: "note-1",
        disputeId: dispute.id,
        author: "system",
        note: "",
        createdAt: new Date(),
      });
      jest.spyOn(DisputeService.prototype, "updateDispute").mockResolvedValue({
        ...dispute,
        priority: "critical",
      });

      const job = new DisputeSlaJob();
      const result = await job.escalateOverdueDispute(dispute);

      expect(result.previousPriority).toBe("high");
      expect(result.newPriority).toBe("critical");
    });

    it("stays at critical when already at top priority", async () => {
      const dispute = makeDispute({ priority: "critical" });
      jest.spyOn(DisputeService.prototype, "addNote").mockResolvedValue({
        id: "note-1",
        disputeId: dispute.id,
        author: "system",
        note: "",
        createdAt: new Date(),
      });
      // updateDispute should NOT be called when priority doesn't change
      const updateSpy = jest
        .spyOn(DisputeService.prototype, "updateDispute")
        .mockResolvedValue(dispute);

      const job = new DisputeSlaJob();
      const result = await job.escalateOverdueDispute(dispute);

      expect(result.previousPriority).toBe("critical");
      expect(result.newPriority).toBe("critical");
      // updateDispute should not be called because priority didn't change
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("records escalation in history", async () => {
      const dispute = makeDispute({ priority: "medium" });
      jest.spyOn(DisputeService.prototype, "addNote").mockResolvedValue({
        id: "note-1",
        disputeId: dispute.id,
        author: "system",
        note: "",
        createdAt: new Date(),
      });
      jest.spyOn(DisputeService.prototype, "updateDispute").mockResolvedValue({
        ...dispute,
        priority: "high",
      });

      const job = new DisputeSlaJob();
      await job.escalateOverdueDispute(dispute);

      const history = getEscalationHistory(dispute.id);
      expect(history).toHaveLength(1);
      expect(history[0].disputeId).toBe(dispute.id);
      expect(history[0].previousPriority).toBe("medium");
      expect(history[0].newPriority).toBe("high");
      expect(history[0].hoursOverdue).toBeGreaterThan(0);
    });

    it("returns failure result and does not record history when addNote throws", async () => {
      const dispute = makeDispute({ priority: "medium" });
      jest
        .spyOn(DisputeService.prototype, "addNote")
        .mockRejectedValue(new Error("DB unavailable"));

      const job = new DisputeSlaJob();
      const result = await job.escalateOverdueDispute(dispute);

      expect(result.success).toBe(false);
      expect(result.error).toContain("DB unavailable");
      expect(getEscalationHistory(dispute.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // generateSlaReport()
  // -------------------------------------------------------------------------

  describe("generateSlaReport()", () => {
    it("returns a well-formed SLA violation report", async () => {
      jest.spyOn(DisputeService.prototype, "generateReport").mockResolvedValue({
        generatedAt: new Date().toISOString(),
        filter: {},
        summary: [
          { status: "resolved", count: "8", avgResolutionHours: "24" },
          { status: "open", count: "2", avgResolutionHours: null },
        ],
        totals: {
          total: 10,
          open: 2,
          investigating: 0,
          resolved: 8,
          rejected: 0,
          reversed: 0,
          upheld: 0,
        },
      });

      jest.spyOn(DisputeService.prototype, "getOverdueDisputes").mockResolvedValue([
        makeDispute({ id: "d-overdue-1" }),
      ]);

      const job = new DisputeSlaJob();
      const report = await job.generateSlaReport(30);

      expect(report.periodDays).toBe(30);
      expect(report.totalDisputes).toBe(10);
      expect(report.averageResolutionHours).toBe(24);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].disputeId).toBe("d-overdue-1");
      expect(report.violations[0].hoursOverdue).toBeGreaterThan(0);
      expect(report.byPriority).toBeDefined();
      expect(typeof report.complianceRate).toBe("number");
    });

    it("returns 100% compliance when no disputes exist", async () => {
      jest.spyOn(DisputeService.prototype, "generateReport").mockResolvedValue({
        generatedAt: new Date().toISOString(),
        filter: {},
        summary: [],
        totals: {
          total: 0,
          open: 0,
          investigating: 0,
          resolved: 0,
          rejected: 0,
          reversed: 0,
          upheld: 0,
        },
      });
      jest
        .spyOn(DisputeService.prototype, "getOverdueDisputes")
        .mockResolvedValue([]);

      const job = new DisputeSlaJob();
      const report = await job.generateSlaReport(30);

      expect(report.totalDisputes).toBe(0);
      expect(report.overdue).toBe(0);
      expect(report.complianceRate).toBe(100);
    });

    it("includes by-priority breakdown in the report", async () => {
      jest.spyOn(DisputeService.prototype, "generateReport").mockResolvedValue({
        generatedAt: new Date().toISOString(),
        filter: {},
        summary: [],
        totals: {
          total: 0,
          open: 0,
          investigating: 0,
          resolved: 0,
          rejected: 0,
          reversed: 0,
          upheld: 0,
        },
      });
      jest.spyOn(DisputeService.prototype, "getOverdueDisputes").mockResolvedValue([
        makeDispute({ id: "d1", priority: "high" }),
        makeDispute({ id: "d2", priority: "critical" }),
      ]);

      const job = new DisputeSlaJob();
      const report = await job.generateSlaReport(7);

      expect(report.byPriority.high).toBeDefined();
      expect(report.byPriority.critical).toBeDefined();
      expect(report.byPriority.high.overdue).toBe(1);
      expect(report.byPriority.critical.overdue).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Escalation history helpers
  // -------------------------------------------------------------------------

  describe("escalation history", () => {
    it("getEscalationHistory returns all records when no id given", async () => {
      const d1 = makeDispute({ id: "d1", priority: "medium" });
      const d2 = makeDispute({ id: "d2", priority: "low" });

      jest.spyOn(DisputeService.prototype, "addNote").mockResolvedValue({
        id: "note-1",
        disputeId: d1.id,
        author: "system",
        note: "",
        createdAt: new Date(),
      });
      jest.spyOn(DisputeService.prototype, "updateDispute").mockResolvedValue(d1);

      const job = new DisputeSlaJob();
      await job.escalateOverdueDispute(d1);
      await job.escalateOverdueDispute(d2);

      const all = getEscalationHistory();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it("clearEscalationHistory empties the store", async () => {
      const d1 = makeDispute({ id: "d1", priority: "medium" });
      jest.spyOn(DisputeService.prototype, "addNote").mockResolvedValue({
        id: "note-1",
        disputeId: d1.id,
        author: "system",
        note: "",
        createdAt: new Date(),
      });
      jest.spyOn(DisputeService.prototype, "updateDispute").mockResolvedValue(d1);

      const job = new DisputeSlaJob();
      await job.escalateOverdueDispute(d1);

      clearEscalationHistory();
      expect(getEscalationHistory()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Factory functions
  // -------------------------------------------------------------------------

  describe("runDisputeSlaJob()", () => {
    it("resolves without throwing", async () => {
      jest
        .spyOn(DisputeService.prototype, "processSlaWarnings")
        .mockResolvedValue({ warningsSent: 0 });
      jest
        .spyOn(DisputeService.prototype, "getOverdueDisputes")
        .mockResolvedValue([]);

      await expect(runDisputeSlaJob()).resolves.toBeUndefined();
    });
  });

  describe("generateDisputeSlaReport()", () => {
    it("returns a report object with the expected shape", async () => {
      jest.spyOn(DisputeService.prototype, "generateReport").mockResolvedValue({
        generatedAt: new Date().toISOString(),
        filter: {},
        summary: [],
        totals: {
          total: 0,
          open: 0,
          investigating: 0,
          resolved: 0,
          rejected: 0,
          reversed: 0,
          upheld: 0,
        },
      });
      jest
        .spyOn(DisputeService.prototype, "getOverdueDisputes")
        .mockResolvedValue([]);

      const report = await generateDisputeSlaReport(14);

      expect(report).toHaveProperty("generatedAt");
      expect(report).toHaveProperty("periodDays", 14);
      expect(report).toHaveProperty("violations");
      expect(report).toHaveProperty("byPriority");
    });
  });
});
