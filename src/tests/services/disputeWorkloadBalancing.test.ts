/**
 * Tests for dispute workload balancing (#636)
 *
 * Covers:
 *  - DisputeModel.getAgentWorkload  — returns workload ordered by count ASC
 *  - DisputeModel.findLeastLoadedAgent — picks agent with fewest disputes
 *  - DisputeService.autoAssignToLeastLoadedAgent — full assignment flow
 *  - DisputeService.getWorkloadMetrics — delegates to model
 */

import { DisputeService } from "../../services/dispute";
import { DisputeModel, AgentWorkload, Dispute, DisputeStatus, DisputePriority } from "../../models/dispute";
import { TransactionModel } from "../../models/transaction";

jest.mock("../../models/dispute");
jest.mock("../../models/transaction");
jest.mock("../../services/notificationRouter", () => ({
  notificationRouter: { sendDisputeNotification: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../../services/transactionReversalService", () => ({
  TransactionReversalService: jest.fn().mockImplementation(() => ({})),
}));

describe("Dispute workload balancing (#636)", () => {
  let service: DisputeService;
  let mockDisputeModel: jest.Mocked<DisputeModel>;

  const openDispute: Dispute = {
    id: "dispute-1",
    transactionId: "txn-1",
    reason: "Overcharge",
    status: "open" as DisputeStatus,
    assignedTo: null,
    resolution: null,
    reportedBy: "user@example.com",
    priority: "medium" as DisputePriority,
    category: null,
    slaDueDate: null,
    slaWarningSent: false,
    internalNotes: null,
    createdAt: new Date("2026-09-01T10:00:00Z"),
    updatedAt: new Date("2026-09-01T10:00:00Z"),
  };

  const investigatingDispute: Dispute = {
    ...openDispute,
    status: "investigating" as DisputeStatus,
    assignedTo: "agent-a",
  };

  const resolvedDispute: Dispute = {
    ...openDispute,
    status: "resolved" as DisputeStatus,
    resolution: "Refunded",
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockDisputeModel = DisputeModel.prototype as jest.Mocked<DisputeModel>;

    service = new DisputeService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // DisputeModel.getAgentWorkload
  // -------------------------------------------------------------------------

  describe("DisputeModel.getAgentWorkload", () => {
    it("returns workload rows ordered by activeDisputeCount ASC", async () => {
      const expectedWorkload: AgentWorkload[] = [
        { agentName: "agent-c", activeDisputeCount: 1 },
        { agentName: "agent-a", activeDisputeCount: 3 },
        { agentName: "agent-b", activeDisputeCount: 5 },
      ];
      mockDisputeModel.getAgentWorkload.mockResolvedValue(expectedWorkload);

      const result = await mockDisputeModel.getAgentWorkload();

      expect(result).toEqual(expectedWorkload);
      expect(result[0].activeDisputeCount).toBeLessThanOrEqual(result[1].activeDisputeCount);
      expect(result[1].activeDisputeCount).toBeLessThanOrEqual(result[2].activeDisputeCount);
    });

    it("returns an empty array when no agents have active disputes", async () => {
      mockDisputeModel.getAgentWorkload.mockResolvedValue([]);

      const result = await mockDisputeModel.getAgentWorkload();

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // DisputeModel.findLeastLoadedAgent
  // -------------------------------------------------------------------------

  describe("DisputeModel.findLeastLoadedAgent", () => {
    it("returns the agent with the fewest active disputes", async () => {
      mockDisputeModel.findLeastLoadedAgent.mockResolvedValue("agent-c");

      const result = await mockDisputeModel.findLeastLoadedAgent([
        "agent-a",
        "agent-b",
        "agent-c",
      ]);

      expect(result).toBe("agent-c");
    });

    it("returns null for an empty agents list", async () => {
      mockDisputeModel.findLeastLoadedAgent.mockResolvedValue(null);

      const result = await mockDisputeModel.findLeastLoadedAgent([]);

      expect(result).toBeNull();
    });

    it("returns the sole agent when only one is provided", async () => {
      mockDisputeModel.findLeastLoadedAgent.mockResolvedValue("agent-a");

      const result = await mockDisputeModel.findLeastLoadedAgent(["agent-a"]);

      expect(result).toBe("agent-a");
    });
  });

  // -------------------------------------------------------------------------
  // DisputeService.autoAssignToLeastLoadedAgent
  // -------------------------------------------------------------------------

  describe("DisputeService.autoAssignToLeastLoadedAgent", () => {
    it("assigns to the agent with the lowest active dispute count", async () => {
      mockDisputeModel.findById.mockResolvedValue(openDispute);
      mockDisputeModel.findLeastLoadedAgent.mockResolvedValue("agent-c");
      // assignToAgent path: assign() + update()
      mockDisputeModel.assign.mockResolvedValue({
        ...openDispute,
        assignedTo: "agent-c",
        status: "open" as DisputeStatus,
      });
      mockDisputeModel.update.mockResolvedValue({
        ...openDispute,
        assignedTo: "agent-c",
        status: "investigating" as DisputeStatus,
      });

      const result = await service.autoAssignToLeastLoadedAgent("dispute-1", [
        "agent-a",
        "agent-b",
        "agent-c",
      ]);

      expect(mockDisputeModel.findLeastLoadedAgent).toHaveBeenCalledWith([
        "agent-a",
        "agent-b",
        "agent-c",
      ]);
      expect(mockDisputeModel.assign).toHaveBeenCalledWith("dispute-1", "agent-c");
      expect(result.assignedTo).toBe("agent-c");
      expect(result.status).toBe("investigating");
    });

    it("falls back to availableAgents[0] when findLeastLoadedAgent returns null", async () => {
      mockDisputeModel.findById.mockResolvedValue(openDispute);
      mockDisputeModel.findLeastLoadedAgent.mockResolvedValue(null);
      mockDisputeModel.assign.mockResolvedValue({
        ...openDispute,
        assignedTo: "agent-a",
        status: "open" as DisputeStatus,
      });
      mockDisputeModel.update.mockResolvedValue({
        ...openDispute,
        assignedTo: "agent-a",
        status: "investigating" as DisputeStatus,
      });

      const result = await service.autoAssignToLeastLoadedAgent("dispute-1", [
        "agent-a",
        "agent-b",
      ]);

      expect(mockDisputeModel.assign).toHaveBeenCalledWith("dispute-1", "agent-a");
      expect(result.assignedTo).toBe("agent-a");
    });

    it("throws when availableAgents is empty", async () => {
      await expect(
        service.autoAssignToLeastLoadedAgent("dispute-1", []),
      ).rejects.toThrow("availableAgents must not be empty");

      expect(mockDisputeModel.findById).not.toHaveBeenCalled();
    });

    it("throws when the dispute does not exist", async () => {
      mockDisputeModel.findById.mockResolvedValue(null);

      await expect(
        service.autoAssignToLeastLoadedAgent("dispute-missing", ["agent-a"]),
      ).rejects.toThrow("Dispute dispute-missing not found");
    });

    it("throws when the dispute is in a terminal status", async () => {
      mockDisputeModel.findById.mockResolvedValue(resolvedDispute);

      await expect(
        service.autoAssignToLeastLoadedAgent("dispute-1", ["agent-a"]),
      ).rejects.toThrow("Cannot assign a resolved dispute");
    });

    it("works correctly when dispute is already in investigating status", async () => {
      mockDisputeModel.findById.mockResolvedValue(investigatingDispute);
      mockDisputeModel.findLeastLoadedAgent.mockResolvedValue("agent-b");
      mockDisputeModel.assign.mockResolvedValue({
        ...investigatingDispute,
        assignedTo: "agent-b",
      });
      // Status is already 'investigating', so update() should NOT be called
      // to advance to 'investigating' — assignToAgent only auto-advances from 'open'
      mockDisputeModel.update.mockResolvedValue({
        ...investigatingDispute,
        assignedTo: "agent-b",
      });

      const result = await service.autoAssignToLeastLoadedAgent("dispute-1", [
        "agent-a",
        "agent-b",
      ]);

      expect(result.assignedTo).toBe("agent-b");
    });
  });

  // -------------------------------------------------------------------------
  // DisputeService.getWorkloadMetrics
  // -------------------------------------------------------------------------

  describe("DisputeService.getWorkloadMetrics", () => {
    it("delegates to DisputeModel.getAgentWorkload and returns the result", async () => {
      const workload: AgentWorkload[] = [
        { agentName: "agent-a", activeDisputeCount: 2 },
        { agentName: "agent-b", activeDisputeCount: 7 },
      ];
      mockDisputeModel.getAgentWorkload.mockResolvedValue(workload);

      const result = await service.getWorkloadMetrics();

      expect(mockDisputeModel.getAgentWorkload).toHaveBeenCalledTimes(1);
      expect(result).toEqual(workload);
    });

    it("returns an empty array when no agents are active", async () => {
      mockDisputeModel.getAgentWorkload.mockResolvedValue([]);

      const result = await service.getWorkloadMetrics();

      expect(result).toEqual([]);
    });
  });
});
