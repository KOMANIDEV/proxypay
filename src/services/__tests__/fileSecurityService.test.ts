/**
 * Unit tests for the File Security Service.
 *
 * Coverage:
 *   1. computeSha256 / verifyFileIntegrity – integrity checking
 *   2. sniffMimeType / detectMimeMismatch  – type validation beyond extension
 *   3. scanBufferForThreats                – EICAR + executable + script detection
 *   4. scanFile                            – full scan pipeline (ClamAV + fallback)
 *   5. gateUpload                          – infected / clean / quarantined outcomes
 *   6. Quarantine lifecycle                – approve, reject, release expired
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  computeSha256,
  verifyFileIntegrity,
  sniffMimeType,
  detectMimeMismatch,
  scanBufferForThreats,
  scanFile,
  gateUpload,
  approveQuarantinedUpload,
  rejectUpload,
  releaseExpiredQuarantines,
  EICAR_TEST_STRING,
} from "../fileSecurityService";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));

import { pool } from "../../config/database";

const mockQuery = pool.query as jest.Mock;

function makeFile(
  buffer: Buffer,
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: "document",
    originalname: "document.pdf",
    encoding: "7bit",
    mimetype: "application/pdf",
    buffer,
    size: buffer.length,
    stream: null as any,
    destination: "",
    filename: "",
    path: "",
    ...overrides,
  };
}

const PDF_HEADER = Buffer.from("%PDF-1.7\n1 0 obj\n", "latin1");
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// 1. Integrity checking
// ---------------------------------------------------------------------------

describe("computeSha256 / verifyFileIntegrity", () => {
  it("computes the expected SHA-256 for a known input", () => {
    // SHA-256 of "hello world"
    const digest = computeSha256(Buffer.from("hello world", "utf8"));
    expect(digest).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("verifies integrity when the hash matches", () => {
    const buffer = Buffer.from("some file content", "utf8");
    expect(verifyFileIntegrity(buffer, computeSha256(buffer))).toBe(true);
  });

  it("detects tampering", () => {
    const buffer = Buffer.from("original content", "utf8");
    const digest = computeSha256(buffer);
    const tampered = Buffer.from("original contentX", "utf8");
    expect(verifyFileIntegrity(tampered, digest)).toBe(false);
  });

  it("rejects an empty expected hash", () => {
    expect(verifyFileIntegrity(Buffer.from("x"), "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. File type validation beyond extension
// ---------------------------------------------------------------------------

describe("sniffMimeType", () => {
  it("detects PDF magic bytes", () => {
    expect(sniffMimeType(PDF_HEADER)).toBe("application/pdf");
  });

  it("detects PNG magic bytes", () => {
    expect(sniffMimeType(PNG_MAGIC)).toBe("image/png");
  });

  it("detects JPEG magic bytes", () => {
    expect(sniffMimeType(JPEG_MAGIC)).toBe("image/jpeg");
  });

  it("detects ZIP (docx/xlsx) magic bytes", () => {
    expect(sniffMimeType(ZIP_MAGIC)).toBe("application/zip");
  });

  it("returns null for an empty buffer", () => {
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe("detectMimeMismatch", () => {
  it("reports a mismatch when a script is disguised as a PDF", () => {
    const disguised = Buffer.from(
      "<script>eval(document.write('<script>'))</script>",
      "latin1",
    );
    const result = detectMimeMismatch("application/pdf", disguised);
    expect(result.mismatch).toBe(true);
    expect(result.declared).toBe("application/pdf");
    expect(result.detected).toBe("text/plain");
  });

  it("accepts a genuine PDF with a matching declared type", () => {
    const result = detectMimeMismatch("application/pdf", PDF_HEADER);
    expect(result.mismatch).toBe(false);
  });

  it("treats image/jpg as equivalent to image/jpeg", () => {
    const result = detectMimeMismatch("image/jpg", JPEG_MAGIC);
    expect(result.mismatch).toBe(false);
  });

  it("reports a mismatch when a zip is labelled as an image", () => {
    const result = detectMimeMismatch("image/png", ZIP_MAGIC);
    expect(result.mismatch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Embedded signature scanner
// ---------------------------------------------------------------------------

describe("scanBufferForThreats", () => {
  it("flags the EICAR test file", () => {
    const result = scanBufferForThreats(
      Buffer.from(EICAR_TEST_STRING, "latin1"),
    );
    expect(result.threats).toContain("Eicar-Test-Signature");
  });

  it("flags an MZ executable embedded in an upload", () => {
    const exe = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(128)]);
    const result = scanBufferForThreats(exe);
    expect(result.threats).toContain("Executable-MZ");
  });

  it("flags a PDF with embedded JavaScript", () => {
    const pdf = Buffer.concat([
      PDF_HEADER,
      Buffer.from("\n/JavaScript << /JS (app.alert(1)) >>", "latin1"),
    ]);
    const result = scanBufferForThreats(pdf);
    expect(result.threats).toContain("Pdf-JavaScript");
  });

  it("returns no threats for a clean PDF", () => {
    const result = scanBufferForThreats(PDF_HEADER);
    expect(result.threats).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Full scan pipeline
// ---------------------------------------------------------------------------

describe("scanFile", () => {
  it("flags an infected upload via the embedded scanner when ClamAV is absent", async () => {
    const file = makeFile(Buffer.from(EICAR_TEST_STRING, "latin1"));
    const outcome = await scanFile(file);
    expect(outcome.status).toBe("infected");
    expect(outcome.threats).toContain("Eicar-Test-Signature");
    expect(outcome.detectedMimetype).toBe("text/plain");
  });

  it("reports clean for a benign PDF", async () => {
    const file = makeFile(PDF_HEADER);
    const outcome = await scanFile(file);
    expect(outcome.status).toBe("clean");
    expect(outcome.threats).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Upload gating (DB-backed)
// ---------------------------------------------------------------------------

describe("gateUpload", () => {
  it("returns infected and persists the record when malware is found", async () => {
    const file = makeFile(Buffer.from(EICAR_TEST_STRING, "latin1"), {
      originalname: "malware.pdf",
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "rec-1",
          user_id: "user-1",
          original_filename: "malware.pdf",
          stored_key: null,
          declared_mimetype: "application/pdf",
          detected_mimetype: "text/plain",
          sha256: computeSha256(file.buffer),
          size_bytes: file.size,
          scan_status: "infected",
          scan_engine: "embedded-signature-scanner",
          threats: ["Eicar-Test-Signature"],
          quarantine_until: null,
          scanned_at: new Date(),
          approved_at: null,
          created_at: new Date(),
        },
      ],
    });

    const result = await gateUpload(file, { userId: "user-1" });
    expect(result.outcome).toBe("infected");
    expect(result.record?.scanStatus).toBe("infected");
    expect(result.reason).toContain("malware detected");
  });

  it("returns clean and persists the record for a benign upload", async () => {
    const file = makeFile(PDF_HEADER, { originalname: "passport.pdf" });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "rec-2",
          user_id: "user-1",
          original_filename: "passport.pdf",
          stored_key: null,
          declared_mimetype: "application/pdf",
          detected_mimetype: "application/pdf",
          sha256: computeSha256(file.buffer),
          size_bytes: file.size,
          scan_status: "clean",
          scan_engine: "embedded-signature-scanner",
          threats: [],
          quarantine_until: null,
          scanned_at: new Date(),
          approved_at: null,
          created_at: new Date(),
        },
      ],
    });

    const result = await gateUpload(file, { userId: "user-1" });
    expect(result.outcome).toBe("clean");
    expect(result.record?.sha256).toBe(computeSha256(file.buffer));
  });

  it("returns error and no record when persistence fails", async () => {
    const file = makeFile(PDF_HEADER);
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));
    const result = await gateUpload(file);
    expect(result.outcome).toBe("error");
    expect(result.record).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Quarantine lifecycle
// ---------------------------------------------------------------------------

describe("quarantine lifecycle", () => {
  it("approves a quarantined upload when the content hash matches", async () => {
    const buffer = PDF_HEADER;
    const record = {
      id: "rec-q1",
      user_id: null,
      original_filename: "doc.pdf",
      stored_key: "kyc-documents/2026/08/u/doc.pdf",
      declared_mimetype: "application/pdf",
      detected_mimetype: "application/pdf",
      sha256: computeSha256(buffer),
      size_bytes: buffer.length,
      scan_status: "quarantined",
      scan_engine: "clamav",
      threats: [],
      quarantine_until: new Date(Date.now() + 60_000),
      scanned_at: new Date(),
      approved_at: null,
      created_at: new Date(),
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [record] }) // getUploadSecurityRecord
      .mockResolvedValueOnce({
        rows: [{ ...record, scan_status: "approved", approved_at: new Date() }],
      }); // UPDATE

    const result = await approveQuarantinedUpload("rec-q1", { buffer });
    expect(result.success).toBe(true);
    expect(result.record?.scanStatus).toBe("approved");
  });

  it("rejects approval when the buffer hash does not match the record", async () => {
    const buffer = PDF_HEADER;
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "rec-q2",
          user_id: null,
          original_filename: "doc.pdf",
          stored_key: null,
          declared_mimetype: "application/pdf",
          detected_mimetype: "application/pdf",
          sha256: computeSha256(Buffer.from("totally different content")),
          size_bytes: buffer.length,
          scan_status: "quarantined",
          scan_engine: "clamav",
          threats: [],
          quarantine_until: new Date(Date.now() + 60_000),
          scanned_at: new Date(),
          approved_at: null,
          created_at: new Date(),
        },
      ],
    });

    const result = await approveQuarantinedUpload("rec-q2", { buffer });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Integrity check failed");
  });

  it("refuses to approve an infected upload", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "rec-i1",
          user_id: null,
          original_filename: "bad.pdf",
          stored_key: null,
          declared_mimetype: "application/pdf",
          detected_mimetype: null,
          sha256: "a".repeat(64),
          size_bytes: 10,
          scan_status: "infected",
          scan_engine: "clamav",
          threats: ["Eicar-Test-Signature"],
          quarantine_until: null,
          scanned_at: new Date(),
          approved_at: null,
          created_at: new Date(),
        },
      ],
    });

    const result = await approveQuarantinedUpload("rec-i1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("infected");
  });

  it("rejects an upload after manual review", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await rejectUpload("rec-q3");
    expect(result.success).toBe(true);
  });

  it("releases quarantined uploads whose period has elapsed", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "a" }, { id: "b" }],
      rowCount: 2,
    });
    const released = await releaseExpiredQuarantines();
    expect(released).toBe(2);
    expect(mockQuery.mock.calls[0][0]).toContain("quarantine_until <= NOW()");
  });
});
