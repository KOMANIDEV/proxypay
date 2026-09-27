/**
 * Route tests for the profile picture upload.
 *
 * Verifies the original upload is gated through the security pipeline
 * (`gateUpload`) *before* sharp re-encodes it and the result is stored:
 *   - clean    → optimized, stored, S3 key linked to the security record
 *   - infected → rejected with 400, nothing stored
 *   - quarantined → rejected with 400, nothing stored
 */

import request from "supertest";
import express from "express";
import { userRoutes } from "../users";
import { gateUpload, linkStoredKey } from "../../services/fileSecurityService";
import { uploadToS3 } from "../../services/s3Upload";

// Fully mock the upload middleware so the sharp dependency is never loaded.
// `upload.single` is backed by real multer so multipart parsing still works;
// `optimizeProfileImage` is a no-op so the route logic is exercised directly.
jest.mock("../../middleware/upload", () => {
  const multer = require("multer");
  return {
    upload: {
      single: (name: string) =>
        multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: 5 * 1024 * 1024 },
        }).single(name),
    },
    optimizeProfileImage: jest.fn((_req: any, _res: any, next: any) => next()),
  };
});

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));

jest.mock("../../services/s3Upload", () => ({
  uploadToS3: jest.fn(),
}));

jest.mock("../../services/fileSecurityService", () => ({
  gateUpload: jest.fn(),
  linkStoredKey: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", role: "user" };
    next();
  },
}));

const mockGateUpload = gateUpload as jest.Mock;
const mockLinkStoredKey = linkStoredKey as jest.Mock;
const mockUploadToS3 = uploadToS3 as jest.Mock;

function securityRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "sec-1",
    userId: "user-1",
    originalFilename: "avatar.png",
    storedKey: null,
    declaredMimetype: "image/png",
    detectedMimetype: "image/png",
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

describe("POST /api/users/profile-picture", () => {
  let app: express.Application;
  let mockPoolQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/users", userRoutes);
    app.use(errorHandler);

    mockPoolQuery = require("../../config/database").pool.query as jest.Mock;
    mockPoolQuery.mockResolvedValue({
      rows: [{ id: "user-1", profile_url: "https://bucket.s3.amazonaws.com/avatar.webp" }],
    });

    mockUploadToS3.mockResolvedValue({
      success: true,
      fileUrl: "https://bucket.s3.amazonaws.com/avatar.webp",
      key: "profile-pictures/2026/08/user-1/avatar.webp",
    });
  });

  it("stores a clean image and links the S3 key to the security record", async () => {
    mockGateUpload.mockResolvedValue({
      outcome: "clean",
      record: securityRecord(),
    });

    const response = await request(app)
      .post("/api/users/profile-picture")
      .attach("avatar", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), "avatar.png");

    expect(response.status).toBe(200);
    expect(mockGateUpload).toHaveBeenCalledTimes(1);
    // Gate must run on the original buffer (before sharp re-encoding).
    expect(mockGateUpload.mock.calls[0][0].buffer).toBeDefined();
    expect(mockUploadToS3).toHaveBeenCalledTimes(1);
    expect(mockLinkStoredKey).toHaveBeenCalledWith(
      "sec-1",
      "profile-pictures/2026/08/user-1/avatar.webp",
    );
    expect(mockPoolQuery).toHaveBeenCalled();
  });

  it("rejects an infected image before anything is stored", async () => {
    mockGateUpload.mockResolvedValue({
      outcome: "infected",
      record: securityRecord({ scanStatus: "infected", threats: ["Eicar-Test-Signature"] }),
      reason: "Upload rejected: malware detected (Eicar-Test-Signature)",
    });

    const response = await request(app)
      .post("/api/users/profile-picture")
      .attach("avatar", Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR"), "avatar.png");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("security scan");
    expect(mockUploadToS3).not.toHaveBeenCalled();
    expect(mockLinkStoredKey).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("rejects a quarantined image (scan inconclusive) before anything is stored", async () => {
    mockGateUpload.mockResolvedValue({
      outcome: "quarantined",
      record: securityRecord({ scanStatus: "quarantined" }),
      reason: "Scan engine unavailable (clamav); upload quarantined",
    });

    const response = await request(app)
      .post("/api/users/profile-picture")
      .attach("avatar", Buffer.from("not really an image"), "avatar.png");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("quarantined");
    expect(mockUploadToS3).not.toHaveBeenCalled();
  });
});
