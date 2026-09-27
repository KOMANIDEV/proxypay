/**
 * Tests for #402 – KYC Webhook Callback System
 */

import {
  buildKYCWebhookEvent,
  signWebhookPayload,
  verifyWebhookSignature,
  type KYCEventType,
  type KYCStatus,
} from "../../src/services/kycWebhookService";

describe("kycWebhookService", () => {
  // ─── buildKYCWebhookEvent ───────────────────────────────────────────────────

  describe("buildKYCWebhookEvent", () => {
    it("should create an event with the correct structure", () => {
      const event = buildKYCWebhookEvent("kyc.status.changed", {
        object_id: "obj_123",
        object_type: "applicant",
        applicant_id: "app_456",
        status: "approved",
      });

      expect(event.type).toBe("kyc.status.changed");
      expect(event.id).toMatch(/^kyc_evt_/);
      expect(event.api_version).toBe("2026-08-01");
      expect(event.data.applicant_id).toBe("app_456");
      expect(event.data.status).toBe("approved");
      expect(new Date(event.created_at).getTime()).not.toBeNaN();
    });

    it("should generate a unique id for each event", () => {
      const e1 = buildKYCWebhookEvent("kyc.check.completed", {
        object_id: "a",
        object_type: "check",
        applicant_id: "app_1",
        status: "approved",
      });
      const e2 = buildKYCWebhookEvent("kyc.check.completed", {
        object_id: "b",
        object_type: "check",
        applicant_id: "app_2",
        status: "approved",
      });
      expect(e1.id).not.toBe(e2.id);
    });

    it("should accept all valid event types", () => {
      const types: KYCEventType[] = [
        "kyc.check.completed",
        "kyc.check.initiated",
        "kyc.document.uploaded",
        "kyc.applicant.created",
        "kyc.workflow.completed",
        "kyc.status.changed",
      ];
      types.forEach((type) => {
        expect(() =>
          buildKYCWebhookEvent(type, {
            object_id: "id",
            object_type: "applicant",
            applicant_id: "app",
            status: "pending",
          }),
        ).not.toThrow();
      });
    });

    it("should preserve optional fields", () => {
      const event = buildKYCWebhookEvent("kyc.status.changed", {
        object_id: "obj",
        object_type: "applicant",
        applicant_id: "app",
        status: "rejected",
        previous_status: "review",
        rejection_reasons: ["document_expired", "photo_mismatch"],
        metadata: { reviewer: "auto" },
      });
      expect(event.data.previous_status).toBe("review");
      expect(event.data.rejection_reasons).toEqual(["document_expired", "photo_mismatch"]);
      expect(event.data.metadata?.reviewer).toBe("auto");
    });
  });

  // ─── signWebhookPayload ─────────────────────────────────────────────────────

  describe("signWebhookPayload", () => {
    it("should produce a signature with t= and v1= components", () => {
      const sig = signWebhookPayload('{"hello":"world"}', "test-secret");
      expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });

    it("should produce different signatures for different payloads", () => {
      const s1 = signWebhookPayload('{"a":1}', "secret");
      const s2 = signWebhookPayload('{"a":2}', "secret");
      expect(s1).not.toBe(s2);
    });

    it("should produce different signatures for different secrets", () => {
      const s1 = signWebhookPayload('{"a":1}', "secret1");
      const s2 = signWebhookPayload('{"a":1}', "secret2");
      expect(s1).not.toBe(s2);
    });
  });

  // ─── verifyWebhookSignature ─────────────────────────────────────────────────

  describe("verifyWebhookSignature", () => {
    it("should verify a signature produced by signWebhookPayload", () => {
      const payload = '{"event":"test"}';
      const secret = "my-webhook-secret";
      const sig = signWebhookPayload(payload, secret);
      expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
    });

    it("should reject a tampered payload", () => {
      const payload = '{"event":"test"}';
      const secret = "my-webhook-secret";
      const sig = signWebhookPayload(payload, secret);
      expect(
        verifyWebhookSignature('{"event":"tampered"}', sig, secret),
      ).toBe(false);
    });

    it("should reject a wrong secret", () => {
      const payload = '{"event":"test"}';
      const sig = signWebhookPayload(payload, "correct-secret");
      expect(verifyWebhookSignature(payload, sig, "wrong-secret")).toBe(false);
    });

    it("should reject an expired signature", () => {
      const payload = '{"event":"test"}';
      const secret = "test-secret";
      // Manually build a signature with a timestamp 10 minutes in the past
      const ts = Math.floor(Date.now() / 1000) - 700;
      const crypto = require("crypto");
      const hmac = crypto
        .createHmac("sha256", secret)
        .update(`${ts}.${payload}`)
        .digest("hex");
      const staleSig = `t=${ts},v1=${hmac}`;
      expect(verifyWebhookSignature(payload, staleSig, secret, 300)).toBe(false);
    });

    it("should return false for a malformed signature", () => {
      expect(verifyWebhookSignature('{}', "not-a-real-sig", "secret")).toBe(false);
    });
  });
});
