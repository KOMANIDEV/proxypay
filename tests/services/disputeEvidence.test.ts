/**
 * Tests for #413 — Dispute Evidence Organization by Category
 *  - Evidence categorization
 *  - Drag-and-drop reorder
 *  - Evidence search (keyword + category filter)
 *  - Timeline view
 *  - Evidence grouped by category
 */

// ---------------------------------------------------------------------------
// All mocks MUST be declared before any imports that use them
// ---------------------------------------------------------------------------

const mockModel = {
  findById: jest.fn(),
  findByIdWithDetails: jest.fn(),
  updateEvidenceCategory: jest.fn(),
  reorderEvidence: jest.fn(),
  searchEvidence: jest.fn(),
  getEvidence: jest.fn(),
  findByIdWithNotes: jest.fn(),
  addNote: jest.fn(),
  addEvidence: jest.fn(),
  assign: jest.fn(),
  update: jest.fn(),
  create: jest.fn(),
  findActiveByTransactionId: jest.fn(),
  findSlaWarningCandidates: jest.fn(),
  markSlaWarningSent: jest.fn(),
  findOverdueDisputes: jest.fn(),
  generateReport: jest.fn(),
};

jest.mock("../../src/models/dispute", () => ({
  DisputeModel: jest.fn().mockImplementation(() => mockModel),
}));

jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../src/utils/logger", () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock("../../src/services/notificationRouter", () => ({
  notificationRouter: {
    sendDisputeNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

// Static imports after mocks
import { DisputeService } from "../../src/services/dispute";
import {
  EVIDENCE_CATEGORIES,
  EvidenceCategory,
} from "../../src/routes/disputes";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const DISPUTE_ID = "dispute-abc-123";
const EVIDENCE_ID = "evidence-xyz-456";

const mockDispute = {
  id: DISPUTE_ID,
  transactionId: "txn-001",
  status: "open" as const,
  reason: "test dispute",
  priority: "medium" as const,
  category: null,
  assignedTo: null,
  resolution: null,
  reportedBy: null,
  slaDueDate: null,
  slaWarningSent: false,
  internalNotes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockEvidenceItem = {
  id: EVIDENCE_ID,
  disputeId: DISPUTE_ID,
  fileName: "receipt.pdf",
  fileType: "application/pdf",
  fileSize: 102400,
  s3Key: "dispute-evidence/2026/01/dispute-abc-123/receipt.pdf",
  s3Url: "https://s3.example.com/receipt.pdf",
  uploadedBy: "user-1",
  description: "Payment receipt",
  category: "transaction_proof",
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------
// Unit tests for the category constants
// ---------------------------------------------------------------------------

describe("#413 Evidence Category Constants", () => {
  it("defines the expected evidence categories", () => {
    expect(EVIDENCE_CATEGORIES).toContain("transaction_proof");
    expect(EVIDENCE_CATEGORIES).toContain("communication");
    expect(EVIDENCE_CATEGORIES).toContain("merchant_statement");
    expect(EVIDENCE_CATEGORIES).toContain("identity_document");
    expect(EVIDENCE_CATEGORIES).toContain("bank_statement");
    expect(EVIDENCE_CATEGORIES).toContain("screenshot");
    expect(EVIDENCE_CATEGORIES).toContain("other");
  });

  it("has no duplicate categories", () => {
    const unique = new Set(EVIDENCE_CATEGORIES);
    expect(unique.size).toBe(EVIDENCE_CATEGORIES.length);
  });

  it("transaction_proof, communication, merchant_statement are the primary required categories", () => {
    const required: EvidenceCategory[] = [
      "transaction_proof",
      "communication",
      "merchant_statement",
    ];
    for (const cat of required) {
      expect(EVIDENCE_CATEGORIES).toContain(cat);
    }
  });

  it("EVIDENCE_CATEGORIES only contains non-empty strings", () => {
    for (const cat of EVIDENCE_CATEGORIES) {
      expect(typeof cat).toBe("string");
      expect(cat.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// DisputeService — evidence organization methods
// ---------------------------------------------------------------------------

describe("#413 DisputeService — evidence organization", () => {
  let service: DisputeService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mocks to defaults
    mockModel.findById.mockResolvedValue(mockDispute);
    mockModel.findByIdWithDetails.mockResolvedValue({
      ...mockDispute,
      notes: [],
      evidence: [mockEvidenceItem],
      timeline: [
        {
          id: "t1",
          disputeId: DISPUTE_ID,
          eventType: "status_changed",
          oldStatus: null,
          newStatus: "open",
          actor: "system",
          description: "Dispute opened",
          metadata: null,
          createdAt: new Date(),
        },
      ],
    });
    mockModel.updateEvidenceCategory.mockResolvedValue({
      ...mockEvidenceItem,
      category: "transaction_proof",
    });
    mockModel.reorderEvidence.mockResolvedValue(2);
    mockModel.searchEvidence.mockResolvedValue([mockEvidenceItem]);
    mockModel.getEvidence.mockResolvedValue([
      { ...mockEvidenceItem, category: "transaction_proof" },
      {
        ...mockEvidenceItem,
        id: "ev-2",
        fileName: "chat.png",
        category: "communication",
      },
    ]);

    service = new DisputeService();
    // Directly inject the mock model so tests don't depend on constructor DI
    (service as any).disputeModel = mockModel;
    (service as any).transactionModel = {};
  });

  // -------------------------------------------------------------------------
  // updateEvidenceCategory
  // -------------------------------------------------------------------------

  it("updateEvidenceCategory calls model with correct params", async () => {
    const result = await service.updateEvidenceCategory(
      DISPUTE_ID,
      EVIDENCE_ID,
      "transaction_proof",
    );

    expect(mockModel.updateEvidenceCategory).toHaveBeenCalledWith(
      EVIDENCE_ID,
      DISPUTE_ID,
      "transaction_proof",
    );
    expect(result).toMatchObject({ category: "transaction_proof" });
  });

  it("updateEvidenceCategory throws when dispute not found", async () => {
    mockModel.findById.mockResolvedValueOnce(null);

    await expect(
      service.updateEvidenceCategory("nonexistent", EVIDENCE_ID, "communication"),
    ).rejects.toThrow("not found");
  });

  // -------------------------------------------------------------------------
  // reorderEvidence
  // -------------------------------------------------------------------------

  it("reorderEvidence calls model and returns updated count", async () => {
    const order = [
      { id: "ev-1", position: 0 },
      { id: "ev-2", position: 1 },
    ];
    const count = await service.reorderEvidence(DISPUTE_ID, order);

    expect(mockModel.reorderEvidence).toHaveBeenCalledWith(DISPUTE_ID, order);
    expect(count).toBe(2);
  });

  it("reorderEvidence throws when dispute not found", async () => {
    mockModel.findById.mockResolvedValueOnce(null);

    await expect(
      service.reorderEvidence("nonexistent", []),
    ).rejects.toThrow("not found");
  });

  // -------------------------------------------------------------------------
  // searchEvidence
  // -------------------------------------------------------------------------

  it("searchEvidence calls model with query and category", async () => {
    const results = await service.searchEvidence(
      DISPUTE_ID,
      "receipt",
      "transaction_proof",
    );

    expect(mockModel.searchEvidence).toHaveBeenCalledWith(
      DISPUTE_ID,
      "receipt",
      "transaction_proof",
    );
    expect(results).toHaveLength(1);
    expect(results[0].fileName).toBe("receipt.pdf");
  });

  it("searchEvidence calls model without category when not provided", async () => {
    await service.searchEvidence(DISPUTE_ID, "receipt");

    expect(mockModel.searchEvidence).toHaveBeenCalledWith(
      DISPUTE_ID,
      "receipt",
      undefined,
    );
  });

  it("searchEvidence throws when dispute not found", async () => {
    mockModel.findById.mockResolvedValueOnce(null);

    await expect(
      service.searchEvidence("nonexistent", "keyword"),
    ).rejects.toThrow("not found");
  });

  // -------------------------------------------------------------------------
  // getTimeline
  // -------------------------------------------------------------------------

  it("getTimeline returns timeline array from dispute details", async () => {
    const timeline = await service.getTimeline(DISPUTE_ID);

    expect(Array.isArray(timeline)).toBe(true);
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline[0].eventType).toBe("status_changed");
    expect(timeline[0].newStatus).toBe("open");
  });

  it("getTimeline throws when dispute not found", async () => {
    mockModel.findByIdWithDetails.mockResolvedValueOnce(null);

    await expect(service.getTimeline("nonexistent")).rejects.toThrow("not found");
  });

  // -------------------------------------------------------------------------
  // getEvidenceByCategory
  // -------------------------------------------------------------------------

  it("getEvidenceByCategory groups evidence by category key", async () => {
    const grouped = await service.getEvidenceByCategory(DISPUTE_ID);

    expect(grouped).toHaveProperty("transaction_proof");
    expect(grouped).toHaveProperty("communication");
    expect(Array.isArray(grouped["transaction_proof"])).toBe(true);
    expect(grouped["transaction_proof"][0].fileName).toBe("receipt.pdf");
    expect(grouped["communication"][0].fileName).toBe("chat.png");
  });

  it("getEvidenceByCategory returns empty object when no evidence", async () => {
    mockModel.getEvidence.mockResolvedValueOnce([]);
    const grouped = await service.getEvidenceByCategory(DISPUTE_ID);
    expect(Object.keys(grouped)).toHaveLength(0);
  });

  it("getEvidenceByCategory throws when dispute not found", async () => {
    mockModel.findById.mockResolvedValueOnce(null);

    await expect(
      service.getEvidenceByCategory("nonexistent"),
    ).rejects.toThrow("not found");
  });
});
