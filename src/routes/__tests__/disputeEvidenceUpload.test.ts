/**
 * Route tests for dispute evidence uploads.
 *
 * Verifies that every evidence file is gated through the security pipeline
 * (`gateUpload`) before it is written to S3:
 *   - clean       → allowed, stored, and the S3 key is linked to the record
 *   - infected    → rejected with 400, nothing stored
 *   - quarantined → rejected with 400, nothing stored
 *   - scan error  → rejected with 500, nothing stored
 *   - multiple    → whole batch rejected if any single file fails
 */

import request from "supertest";
import express from "express";
import { disputeRoutes } from "../disputes";
import {
  gateUpload,
  linkStoredKey,
} from "../../services/fileSecurityService";
import {
  uploadDisputeEvidenceToS3,
  uploadMultipleDisputeEvidenceToS3,
} from "../../services/disputeS3Upload";

jest.mock("../../services/fileSecurityService", () => ({
  gateUpload: jest.fn(),
  linkStoredKey: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/disputeS3Upload", () => ({
  uploadDisputeEvidenceToS3: jest.fn(),
  uploadMultipleDisputeEvidenceToS3: jest.fn(),
  validateDisputeEvidenceFile: jest.fn().mockReturnValue({ valid: true }),
}));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", role: "user" };
    next();
  },
}));

jest.mock("../../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../services/dispute", () => ({
  DisputeService: jest.fn().mockImplementation(() => ({
    addEvidence: jest.fn().mockResolvedValue({ id: "evidence-1" }),
  })),
}));

const mockGateUpload = gateUpload as jest.Mock;
const mockLinkStoredKey = linkStoredKey as jest.Mock;
const mockUploadEvidence = uploadDisputeEvidenceToS3 as jest.Mock;
const mockUploadMultiple = uploadMultipleDisputeEvidenceToS3 as jest.Mock;

function securityRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "sec-1",
    userId: "user-1",
    originalFilename: "evidence.pdf",
    storedKey: null,
    declaredMimetype: "application/pdf",
    detectedMimetype: "application/pdf",
    sha256: "a".repeat(64),
    sizeBytes: 10,
    scanStatus: "clean",
    scanEngine: "embedded-signature-scanner",
    threats: [],
    quarantineUntil: null,
    scannedAt: new Date(),
    approvedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function errorHandler(
  err: any,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) {
  const status = err.statusCode ?? err.status ?? 500;
  res.status(status).json({
    error: err.message,
    details: err.details,
  });
}

describe("POST /api/disputes/:disputeId/evidence", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/disputes", disputeRoutes);
    app.use(errorHandler);

    mockUploadEvidence.mockResolvedValue({
      success: true,
      fileUrl: "https://bucket.s3.amazonaws.com/evidence.pdf",
      key: "dispute-evidence/2026/08/dispute-1/evidence.pdf",
    });
    mockUploadMultiple.mockResolvedValue([
      {
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/a.pdf",
        key: "dispute-evidence/2026/08/dispute-1/a.pdf",
      },
      {
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/b.pdf",
        key: "dispute-evidence/2026/08/dispute-1/b.pdf",
      },
    ]);
  });

  it("stores a clean file and links the S3 key to the security record", async () => {
    mockGateUpload.mockResolvedValue({
      outcome: "clean",
      record: securityRecord(),
    });

    const response = await request(app)
      .post("/api/disputes/dispute-1/evidence")
      .attach("file", Buffer.from("%PDF-1.7 clean evidence"), "evidence.pdf")
      .field("description", "proof of payment");

    expect(response.status).toBe(201);
    expect(mockUploadEvidence).toHaveBeenCalledTimes(1);
    expect(mockLinkStoredKey).toHaveBeenCalledWith(
      "sec-1",
      "dispute-evidence/2026/08/dispute-1/evidence.pdf",
    );
  });

  it("rejects an infected file before it is stored", async () => {
    mockGateUpload.mockResolvedValue({
      outcome: "infected",
      record: securityRecord({ scanStatus: "infected", threats: ["Eicar-Test-Signature"] }),
      reason: "Upload rejected: malware detected (Eicar-Test-Signature)",
    });

    const response = await request(app)
      .post("/api/disputes/dispute-1/evidence")
      .attach("file", Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR"), "evil.pdf");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("security scan");
    expect(mockUploadEvidence).not.toHaveBeenCalled();
    expect(mockLinkStoredKey).not.toHaveBeenCalled();
  });

  it("rejects a quarantined file (scan inconclusive) before it is stored", async () => {
    mockGateUpload.mockResolvedValue({
      outcome: "quarantined",
      record: securityRecord({ scanStatus: "quarantined" }),
      reason: "Scan engine unavailable (clamav); upload quarantined",
    });

    const response = await request(app)
      .post("/api/disputes/dispute-1/evidence")
      .attach("file", Buffer.from("%PDF-1.7 evidence"), "evidence.pdf");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("quarantined");
    expect(mockUploadEvidence).not.toHaveBeenCalled();
  });

  it("fails closed when the security scan errors", async () => {
    mockGateUpload.mockResolvedValue({
      outcome: "error",
      record: null,
      reason: "connection refused",
    });

    const response = await request(app)
      .post("/api/disputes/dispute-1/evidence")
      .attach("file", Buffer.from("%PDF-1.7 evidence"), "evidence.pdf");

    expect(response.status).toBe(500);
    expect(mockUploadEvidence).not.toHaveBeenCalled();
  });
});

describe("POST /api/disputes/:disputeId/evidence/multiple", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/disputes", disputeRoutes);
    app.use(errorHandler);

    mockUploadMultiple.mockResolvedValue([
      {
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/a.pdf",
        key: "dispute-evidence/2026/08/dispute-1/a.pdf",
      },
      {
        success: true,
        fileUrl: "https://bucket.s3.amazonaws.com/b.pdf",
        key: "dispute-evidence/2026/08/dispute-1/b.pdf",
      },
    ]);
  });

  it("stores a batch of clean files and links each S3 key", async () => {
    mockGateUpload.mockResolvedValue({
      outcome: "clean",
      record: securityRecord(),
    });

    const response = await request(app)
      .post("/api/disputes/dispute-1/evidence/multiple")
      .attach("files", Buffer.from("%PDF-1.7 a"), "a.pdf")
      .attach("files", Buffer.from("%PDF-1.7 b"), "b.pdf");

    expect(response.status).toBe(201);
    expect(mockGateUpload).toHaveBeenCalledTimes(2);
    expect(mockUploadMultiple).toHaveBeenCalledTimes(1);
    expect(mockLinkStoredKey).toHaveBeenCalledTimes(2);
  });

  it("rejects the whole batch when one file is infected", async () => {
    mockGateUpload.mockResolvedValueOnce({
      outcome: "clean",
      record: securityRecord(),
    });
    mockGateUpload.mockResolvedValueOnce({
      outcome: "infected",
      record: securityRecord({ scanStatus: "infected", threats: ["Eicar-Test-Signature"] }),
      reason: "Upload rejected: malware detected (Eicar-Test-Signature)",
    });

    const response = await request(app)
      .post("/api/disputes/dispute-1/evidence/multiple")
      .attach("files", Buffer.from("%PDF-1.7 a"), "a.pdf")
      .attach("files", Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR"), "b.pdf");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("security scan");
    expect(mockUploadMultiple).not.toHaveBeenCalled();
    expect(mockLinkStoredKey).not.toHaveBeenCalled();
  });
});
