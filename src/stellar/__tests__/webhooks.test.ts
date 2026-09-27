import request from "supertest";
import express from "express";
import { createHmac, randomUUID } from "crypto";
import { TransactionStatus } from "../../models/transaction";

const mockFindByMetadata = jest.fn();
const mockFindByReferenceNumber = jest.fn();
const mockUpdateStatus = jest.fn();
const mockPatchMetadata = jest.fn();

jest.mock("../../models/transaction", () => {
  return {
    TransactionModel: jest.fn().mockImplementation(() => {
      return {
        findByMetadata: mockFindByMetadata,
        findByReferenceNumber: mockFindByReferenceNumber,
        updateStatus: mockUpdateStatus,
        patchMetadata: mockPatchMetadata,
      };
    }),
    TransactionStatus: {
      Pending: "pending",
      Completed: "completed",
      Failed: "failed",
      Cancelled: "cancelled",
    },
  };
});

const mockNotifyTransactionWebhook = jest.fn();
jest.mock("../../services/webhook", () => ({
  notifyTransactionWebhook: (...args: unknown[]) =>
    mockNotifyTransactionWebhook(...args),
}));

import stellarWebhookRoutes, {
  consumeNonce,
  isTimestampFresh,
  resetNonceStore,
  WEBHOOK_NONCE_TTL_MS,
} from "../webhooks";

describe("Stellar Webhooks", () => {
  let app: express.Application;

  beforeEach(() => {
    process.env.STELLAR_WEBHOOK_SECRET = "test-secret";
    resetNonceStore();

    app = express();
    app.use(express.json());
    app.use(stellarWebhookRoutes);

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.STELLAR_WEBHOOK_SECRET;
  });

  function generateSignature(payload: string, secret: string): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }

  describe("POST /webhook", () => {
    // Payloads carry a fresh timestamp + nonce so replay protection cannot
    // reject a legitimate test request.
    function buildValidPayload(overrides: Record<string, unknown> = {}) {
      return {
        transaction_hash: "abc123def456",
        status: "success",
        ledger: 12345678,
        timestamp: new Date().toISOString(),
        nonce: randomUUID(),
        source_account: "GABC123",
        destination_account: "GDEF456",
        amount: "100.5000000",
        ...overrides,
      };
    }

    let validPayload: ReturnType<typeof buildValidPayload>;

    beforeEach(() => {
      validPayload = buildValidPayload();
    });

    it("should reject webhook when STELLAR_WEBHOOK_SECRET is not configured", async () => {
      delete process.env.STELLAR_WEBHOOK_SECRET;

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Webhook processing not configured");
    });

    it("should reject webhook with invalid signature", async () => {
      const rawPayload = JSON.stringify(validPayload);
      const invalidSignature = generateSignature(rawPayload, "wrong-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", invalidSignature)
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Invalid signature");
    });

    it("should reject webhook with missing signature header", async () => {
      const response = await request(app).post("/webhook").send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Invalid signature");
    });

    it("should reject webhook with malformed signature", async () => {
      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", "malformed-signature")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Invalid signature");
    });

    it("should reject webhook with missing transaction_hash", async () => {
      const invalidPayload = {
        status: "success",
        timestamp: "2026-03-26T10:00:00Z",
      };

      const rawPayload = JSON.stringify(invalidPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(invalidPayload);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.details).toBeDefined();
    });

    it("should reject webhook with missing status", async () => {
      const invalidPayload = {
        transaction_hash: "abc123",
        timestamp: "2026-03-26T10:00:00Z",
      };

      const rawPayload = JSON.stringify(invalidPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(invalidPayload);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.details).toBeDefined();
    });

    it("should reject webhook with unknown status", async () => {
      const invalidPayload = {
        ...validPayload,
        status: "unknown-status",
      };

      const rawPayload = JSON.stringify(invalidPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(invalidPayload);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
      expect(response.body.details).toBeDefined();
    });

    it("should return 404 when transaction not found", async () => {
      mockFindByMetadata.mockResolvedValue([]);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Transaction not found");
      expect(response.body.hash).toBe("abc123def456");
    });

    it("should successfully process webhook and update transaction to completed", async () => {
      const mockTransaction = {
        id: "tx-uuid-123",
        status: TransactionStatus.Pending,
        referenceNumber: "REF123",
        type: "deposit" as const,
        amount: "100",
        phoneNumber: "+123456789",
        provider: "mtn",
        stellarAddress: "GDEF456",
        tags: [],
        createdAt: new Date(),
      };

      mockFindByMetadata.mockResolvedValue([mockTransaction]);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue(mockTransaction);
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(1);

      expect(mockFindByMetadata).toHaveBeenCalledWith({
        stellar_hash: "abc123def456",
      });

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "tx-uuid-123",
        TransactionStatus.Completed,
      );

      expect(mockPatchMetadata).toHaveBeenCalledWith("tx-uuid-123", {
        stellar_ledger: 12345678,
        webhook_processed_at: expect.any(String),
      });

      expect(mockNotifyTransactionWebhook).toHaveBeenCalledWith(
        "tx-uuid-123",
        "transaction.completed",
        expect.objectContaining({ transactionModel: expect.any(Object) }),
      );
    });

    it("should successfully process webhook and update transaction to failed", async () => {
      const mockTransaction = {
        id: "tx-uuid-456",
        status: TransactionStatus.Pending,
        referenceNumber: "REF456",
        type: "withdraw" as const,
        amount: "50",
        phoneNumber: "+987654321",
        provider: "airtel",
        stellarAddress: "GABC123",
        tags: [],
        createdAt: new Date(),
      };

      const failedPayload = {
        ...validPayload,
        status: "failed",
      };

      mockFindByMetadata.mockResolvedValue([mockTransaction]);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue(mockTransaction);
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(failedPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(failedPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(1);

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "tx-uuid-456",
        TransactionStatus.Failed,
      );

      expect(mockNotifyTransactionWebhook).toHaveBeenCalledWith(
        "tx-uuid-456",
        "transaction.failed",
        expect.objectContaining({ transactionModel: expect.any(Object) }),
      );
    });

    it("should update multiple transactions with the same stellar hash", async () => {
      const mockTransactions = [
        {
          id: "tx-uuid-1",
          status: TransactionStatus.Pending,
          referenceNumber: "REF1",
          type: "deposit" as const,
          amount: "100",
          phoneNumber: "+111",
          provider: "mtn",
          stellarAddress: "GDEF456",
          tags: [],
          createdAt: new Date(),
        },
        {
          id: "tx-uuid-2",
          status: TransactionStatus.Pending,
          referenceNumber: "REF2",
          type: "deposit" as const,
          amount: "100",
          phoneNumber: "+222",
          provider: "airtel",
          stellarAddress: "GDEF456",
          tags: [],
          createdAt: new Date(),
        },
      ];

      mockFindByMetadata.mockResolvedValue(mockTransactions);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue({});
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(2);

      expect(mockUpdateStatus).toHaveBeenCalledTimes(2);
      expect(mockPatchMetadata).toHaveBeenCalledTimes(2);
      expect(mockNotifyTransactionWebhook).toHaveBeenCalledTimes(2);
    });

    it("should skip transactions already in completed state", async () => {
      const mockTransaction = {
        id: "tx-uuid-done",
        status: TransactionStatus.Completed,
        referenceNumber: "REF_DONE",
        type: "deposit" as const,
        amount: "100",
        phoneNumber: "+111",
        provider: "mtn",
        stellarAddress: "GDEF456",
        tags: [],
        createdAt: new Date(),
      };

      mockFindByMetadata.mockResolvedValue([mockTransaction]);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(0);

      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockPatchMetadata).not.toHaveBeenCalled();
      expect(mockNotifyTransactionWebhook).not.toHaveBeenCalled();
    });

    it("should skip transactions already in failed state", async () => {
      const mockTransaction = {
        id: "tx-uuid-failed",
        status: TransactionStatus.Failed,
        referenceNumber: "REF_FAILED",
        type: "withdraw" as const,
        amount: "50",
        phoneNumber: "+222",
        provider: "airtel",
        stellarAddress: "GABC123",
        tags: [],
        createdAt: new Date(),
      };

      mockFindByMetadata.mockResolvedValue([mockTransaction]);

      const failedPayload = { ...validPayload, status: "failed" };
      const rawPayload = JSON.stringify(failedPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(failedPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(0);

      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockNotifyTransactionWebhook).not.toHaveBeenCalled();
    });

    it("should only update pending transactions in a mixed batch", async () => {
      const mockTransactions = [
        {
          id: "tx-pending",
          status: TransactionStatus.Pending,
          referenceNumber: "REF_P",
          type: "deposit" as const,
          amount: "100",
          phoneNumber: "+111",
          provider: "mtn",
          stellarAddress: "GDEF456",
          tags: [],
          createdAt: new Date(),
        },
        {
          id: "tx-already-done",
          status: TransactionStatus.Completed,
          referenceNumber: "REF_D",
          type: "deposit" as const,
          amount: "100",
          phoneNumber: "+222",
          provider: "mtn",
          stellarAddress: "GDEF456",
          tags: [],
          createdAt: new Date(),
        },
      ];

      mockFindByMetadata.mockResolvedValue(mockTransactions);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue({});
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.updated).toBe(1);

      expect(mockUpdateStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "tx-pending",
        TransactionStatus.Completed,
      );
      expect(mockNotifyTransactionWebhook).toHaveBeenCalledTimes(1);
    });

    it("should return 500 on database error", async () => {
      mockFindByMetadata.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Internal server error");
    });

    it("should match transaction by text memo mapped to reference number", async () => {
      const mockTransaction = {
        id: "tx-memo-text",
        status: TransactionStatus.Pending,
        referenceNumber: "REF-MEMO-001",
        type: "deposit" as const,
        amount: "100",
        phoneNumber: "+237670000000",
        provider: "mtn",
        stellarAddress: "GDEF456",
        tags: [],
        createdAt: new Date(),
      };

      const payloadWithMemo = {
        ...validPayload,
        memo: { type: "text", value: "REF-MEMO-001" },
      };

      // No match by hash, match by reference number
      mockFindByMetadata.mockResolvedValueOnce([]).mockResolvedValue([]);
      mockFindByReferenceNumber.mockResolvedValue([mockTransaction]);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue(undefined);
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(payloadWithMemo);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(payloadWithMemo);

      expect(response.status).toBe(200);
      expect(response.body.updated).toBe(1);
      expect(mockFindByReferenceNumber).toHaveBeenCalledWith("REF-MEMO-001");
      expect(mockUpdateStatus).toHaveBeenCalledWith("tx-memo-text", TransactionStatus.Completed);
    });

    it("should match transaction by id memo via metadata fallback", async () => {
      const mockTransaction = {
        id: "tx-memo-id",
        status: TransactionStatus.Pending,
        referenceNumber: "OTHER-REF",
        type: "deposit" as const,
        amount: "200",
        phoneNumber: "+237670000001",
        provider: "airtel",
        stellarAddress: "GDEF456",
        tags: [],
        createdAt: new Date(),
      };

      const payloadWithMemo = {
        ...validPayload,
        memo: { type: "id", value: "9876543210" },
      };

      // No match by hash, no match by reference number, match by metadata memo
      mockFindByMetadata
        .mockResolvedValueOnce([])   // stellar_hash lookup
        .mockResolvedValueOnce([mockTransaction]); // memo metadata lookup
      mockFindByReferenceNumber.mockResolvedValue([]);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue(undefined);
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(payloadWithMemo);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(payloadWithMemo);

      expect(response.status).toBe(200);
      expect(response.body.updated).toBe(1);
      expect(mockFindByMetadata).toHaveBeenCalledWith({ memo: "9876543210" });
      expect(mockUpdateStatus).toHaveBeenCalledWith("tx-memo-id", TransactionStatus.Completed);
    });

    it("should match transaction by hash memo via metadata fallback", async () => {
      const mockTransaction = {
        id: "tx-memo-hash",
        status: TransactionStatus.Pending,
        referenceNumber: "OTHER-REF-2",
        type: "deposit" as const,
        amount: "300",
        phoneNumber: "+237670000002",
        provider: "orange",
        stellarAddress: "GDEF456",
        tags: [],
        createdAt: new Date(),
      };

      const payloadWithMemo = {
        ...validPayload,
        memo: { type: "hash", value: "abcdef1234567890" },
      };

      mockFindByMetadata
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([mockTransaction]);
      mockFindByReferenceNumber.mockResolvedValue([]);
      mockUpdateStatus.mockResolvedValue(undefined);
      mockPatchMetadata.mockResolvedValue(undefined);
      mockNotifyTransactionWebhook.mockResolvedValue(null);

      const rawPayload = JSON.stringify(payloadWithMemo);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(payloadWithMemo);

      expect(response.status).toBe(200);
      expect(response.body.updated).toBe(1);
      expect(mockUpdateStatus).toHaveBeenCalledWith("tx-memo-hash", TransactionStatus.Completed);
    });

    it("should return 404 when neither hash nor memo matches any transaction", async () => {
      const payloadWithMemo = {
        ...validPayload,
        memo: { type: "text", value: "UNKNOWN-REF" },
      };

      mockFindByMetadata.mockResolvedValue([]);
      mockFindByReferenceNumber.mockResolvedValue([]);

      const rawPayload = JSON.stringify(payloadWithMemo);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(payloadWithMemo);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Transaction not found");
    });

    it("should reject payload with invalid memo type", async () => {
      const payloadWithBadMemo = {
        ...validPayload,
        memo: { type: "return", value: "something" },
      };

      const rawPayload = JSON.stringify(payloadWithBadMemo);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(payloadWithBadMemo);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
    });

    it("should reject webhooks with a timestamp outside the replay window", async () => {
      const stalePayload = buildValidPayload({
        timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });

      const rawPayload = JSON.stringify(stalePayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(stalePayload);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe("STALE_TIMESTAMP");
    });

    it("should reject webhooks with a far-future timestamp", async () => {
      const futurePayload = buildValidPayload({
        timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

      const rawPayload = JSON.stringify(futurePayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(futurePayload);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe("STALE_TIMESTAMP");
    });

    it("should reject webhooks that omit the nonce", async () => {
      const { nonce, ...payloadWithoutNonce } = validPayload;

      const rawPayload = JSON.stringify(payloadWithoutNonce);
      const signature = generateSignature(rawPayload, "test-secret");

      const response = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(payloadWithoutNonce);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation failed");
    });

    it("should detect and reject replayed webhooks", async () => {
      mockFindByMetadata.mockResolvedValue([]);

      const rawPayload = JSON.stringify(validPayload);
      const signature = generateSignature(rawPayload, "test-secret");

      const first = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      // First delivery is processed (or 404s when no transaction matches) — what
      // matters is that it is not flagged as a replay.
      expect(first.status).not.toBe(409);
      expect(first.body.code).toBeUndefined();

      // Identical delivery replayed immediately — must be rejected.
      const replay = await request(app)
        .post("/webhook")
        .set("X-Stellar-Signature", signature)
        .send(validPayload);

      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe("REPLAY_DETECTED");
    });
  });

  describe("replay protection primitives", () => {
    it("accepts timestamps inside the window and rejects stale/future ones", () => {
      const now = Date.now();
      expect(isTimestampFresh(new Date(now).toISOString(), now)).toBe(true);
      expect(isTimestampFresh(new Date(now - 4 * 60 * 1000).toISOString(), now)).toBe(true);
      expect(isTimestampFresh(new Date(now - 6 * 60 * 1000).toISOString(), now)).toBe(false);
      expect(isTimestampFresh(new Date(now + 6 * 60 * 1000).toISOString(), now)).toBe(false);
      expect(isTimestampFresh("not-a-date", now)).toBe(false);
    });

    it("accepts a nonce once and rejects duplicates until it expires", async () => {
      const now = Date.now();

      expect((await consumeNonce("nonce-abc-123", now)).accepted).toBe(true);
      expect((await consumeNonce("nonce-abc-123", now)).accepted).toBe(false);

      // After the replay window elapses the nonce may be reused.
      const later = now + WEBHOOK_NONCE_TTL_MS + 1;
      expect((await consumeNonce("nonce-abc-123", later)).accepted).toBe(true);
    });
  });
});
