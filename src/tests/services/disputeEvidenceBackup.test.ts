/**
 * Tests for Dispute Evidence S3 Backup Policy (#629)
 *
 * Covers:
 *  - backupDisputeEvidenceToSecondaryBucket() copies to backup bucket
 *  - backupDisputeEvidenceToSecondaryBucket() returns false (non-fatal) on error
 *  - verifyDisputeEvidenceBackup() returns true when object exists in backup
 *  - verifyDisputeEvidenceBackup() returns false when object is missing
 *  - runDisputeEvidenceBackupVerifyJob() reports missing keys correctly
 *  - runDisputeEvidenceBackupVerifyJob() passes when all keys are backed up
 */

import {
  backupDisputeEvidenceToSecondaryBucket,
  verifyDisputeEvidenceBackup,
  DISPUTE_EVIDENCE_BACKUP_BUCKET,
} from "../../services/disputeS3Upload";
import { runDisputeEvidenceBackupVerifyJob } from "../../jobs/disputeEvidenceBackupVerifyJob";

// ---------------------------------------------------------------------------
// Mock AWS SDK clients so no real AWS calls are made
// ---------------------------------------------------------------------------

let mockSend: jest.Mock;

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: (...args: any[]) => mockSend(...args) })),
  };
});

jest.mock("../../config/s3", () => ({
  s3Config: { bucket: "test-primary-bucket", region: "us-east-1" },
  getS3Client: jest.fn().mockImplementation(() => ({ send: (...args: any[]) => mockSend(...args) })),
  getS3ObjectUrl: (key: string) => `https://test-primary-bucket.s3.us-east-1.amazonaws.com/${key}`,
}));

beforeEach(() => {
  mockSend = jest.fn();
});

// ---------------------------------------------------------------------------
// backupDisputeEvidenceToSecondaryBucket
// ---------------------------------------------------------------------------

describe("backupDisputeEvidenceToSecondaryBucket()", () => {
  it("returns true on successful copy", async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await backupDisputeEvidenceToSecondaryBucket("disputes/d1/file.pdf");
    expect(result).toBe(true);
  });

  it("returns false (non-fatal) when copy fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("AccessDenied"));
    const result = await backupDisputeEvidenceToSecondaryBucket("disputes/d1/file.pdf");
    expect(result).toBe(false);
  });

  it("uses the DISPUTE_EVIDENCE_BACKUP_BUCKET as destination", async () => {
    mockSend.mockResolvedValueOnce({});
    await backupDisputeEvidenceToSecondaryBucket("disputes/d2/evidence.png");
    const command = mockSend.mock.calls[0][0];
    // CopyObjectCommand has a Bucket property
    expect(command?.input?.Bucket ?? command?.Bucket).toBe(DISPUTE_EVIDENCE_BACKUP_BUCKET);
  });
});

// ---------------------------------------------------------------------------
// verifyDisputeEvidenceBackup
// ---------------------------------------------------------------------------

describe("verifyDisputeEvidenceBackup()", () => {
  it("returns true when the object exists in the backup bucket", async () => {
    mockSend.mockResolvedValueOnce({ ContentLength: 1024 });
    const exists = await verifyDisputeEvidenceBackup("disputes/d1/file.pdf");
    expect(exists).toBe(true);
  });

  it("returns false when the object does not exist", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("NotFound"), { name: "NotFound" }));
    const exists = await verifyDisputeEvidenceBackup("disputes/d1/missing.pdf");
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDisputeEvidenceBackupVerifyJob
// ---------------------------------------------------------------------------

describe("runDisputeEvidenceBackupVerifyJob()", () => {
  it("passes when all recent evidence files are in the backup bucket", async () => {
    // ListObjectsV2 returns one recent object
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: "disputes/d1/file.pdf", LastModified: new Date() },
      ],
      NextContinuationToken: undefined,
    });
    // HeadObject for backup check — exists
    mockSend.mockResolvedValueOnce({ ContentLength: 512 });

    const result = await runDisputeEvidenceBackupVerifyJob(25);
    expect(result.passed).toBe(true);
    expect(result.checkedCount).toBe(1);
    expect(result.missingCount).toBe(0);
  });

  it("reports missing keys when backup objects are absent", async () => {
    // ListObjectsV2 returns two recent objects
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: "disputes/d1/a.pdf", LastModified: new Date() },
        { Key: "disputes/d1/b.pdf", LastModified: new Date() },
      ],
      NextContinuationToken: undefined,
    });
    // First HeadObject — exists
    mockSend.mockResolvedValueOnce({ ContentLength: 100 });
    // Second HeadObject — not found
    mockSend.mockRejectedValueOnce(Object.assign(new Error("NotFound"), { name: "NotFound" }));

    const result = await runDisputeEvidenceBackupVerifyJob(25);
    expect(result.passed).toBe(false);
    expect(result.checkedCount).toBe(2);
    expect(result.missingCount).toBe(1);
    expect(result.missingKeys).toContain("disputes/d1/b.pdf");
  });

  it("passes with zero checks when no recent files are present", async () => {
    mockSend.mockResolvedValueOnce({ Contents: [], NextContinuationToken: undefined });

    const result = await runDisputeEvidenceBackupVerifyJob(25);
    expect(result.passed).toBe(true);
    expect(result.checkedCount).toBe(0);
  });

  it("returns passed=false when primary bucket listing fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("NetworkError"));
    const result = await runDisputeEvidenceBackupVerifyJob(25);
    expect(result.passed).toBe(false);
    expect(result.checkedCount).toBe(0);
  });
});
