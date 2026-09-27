import {
  generatePortalUrl,
  verifyPortalToken,
  consumePortalToken,
  rotatePortalToken,
} from "../merchantPortalService";
import { revokeToken } from "../tokenRevocationService";

// Mock database pool
jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

// Mock token revocation service
jest.mock("../tokenRevocationService", () => ({
  revokeToken: jest.fn(),
  isTokenRevoked: jest.fn().mockResolvedValue(false),
}));

import { pool } from "../../config/database";
const mockPool = pool as jest.Mocked<typeof pool>;
const mockRevokeToken = revokeToken as jest.MockedFunction<typeof revokeToken>;

describe("merchantPortalService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("generatePortalUrl", () => {
    it("generates a portal URL for a valid merchant", async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: "m1",
              name: "Test Merchant",
              email: "test@example.com",
              business_name: "Test Corp",
              phone_number: "+1234567890",
              status: "active",
            },
          ],
          rowCount: 1,
          command: "",
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 1,
          command: "",
          fields: [],
        });

      const result = await generatePortalUrl("m1");

      expect(result.url).toContain("/session?token=");
      expect(result.merchantId).toBe("m1");
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it("throws for non-existent merchant", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: "",
        fields: [],
      });

      await expect(generatePortalUrl("nonexistent")).rejects.toThrow(
        "Merchant not found",
      );
    });
  });

  describe("verifyPortalToken", () => {
    it("returns null for invalid token", async () => {
      const result = await verifyPortalToken("invalid.token.here");
      expect(result).toBeNull();
    });

    it("returns null for empty string", async () => {
      const result = await verifyPortalToken("");
      expect(result).toBeNull();
    });

    it("returns null for malformed token", async () => {
      const result = await verifyPortalToken("abc");
      expect(result).toBeNull();
    });

    it("returns null for revoked token", async () => {
      const crypto = require("crypto");
      const PORTAL_SECRET = process.env.PORTAL_SECRET || "test-secret";
      
      const payload = {
        merchantId: "m1",
        email: "test@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: "revoked-token",
        nonce: "nonce123",
      };

      const data = JSON.stringify(payload);
      const hmac = crypto.createHmac("sha256", PORTAL_SECRET);
      hmac.update(data);
      const signature = hmac.digest("hex");
      const token = Buffer.from(data).toString("base64url") + "." + signature;

      // Mock isTokenRevoked to return true
      const { isTokenRevoked } = require("../tokenRevocationService");
      isTokenRevoked.mockResolvedValueOnce(true);

      const result = await verifyPortalToken(token);
      expect(result).toBeNull();
    });
  });

  describe("rotatePortalToken", () => {
    it("revokes old token and generates new one", async () => {
      const now = Math.floor(Date.now() / 1000);
      const oldTokenJti = "old-token-123";
      const oldTokenExp = now + 3600;
      const merchantId = "m1";

      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: merchantId,
              name: "Test Merchant",
              email: "test@example.com",
              business_name: "Test Corp",
              phone_number: "+1234567890",
              status: "active",
            },
          ],
          rowCount: 1,
          command: "",
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 1,
          command: "",
          fields: [],
        });

      mockRevokeToken.mockResolvedValueOnce();

      const result = await rotatePortalToken(
        merchantId,
        oldTokenJti,
        oldTokenExp,
      );

      // Verify old token was revoked
      expect(mockRevokeToken).toHaveBeenCalledWith(
        oldTokenJti,
        merchantId,
        oldTokenExp,
        "rotation",
        "portal",
      );

      // Verify new token was generated
      expect(result.url).toContain("/session?token=");
      expect(result.merchantId).toBe(merchantId);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("uses custom expiry when provided", async () => {
      const now = Math.floor(Date.now() / 1000);
      const merchantId = "m1";

      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: merchantId,
              name: "Test Merchant",
              email: "test@example.com",
              business_name: "Test Corp",
              phone_number: "+1234567890",
              status: "active",
            },
          ],
          rowCount: 1,
          command: "",
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 1,
          command: "",
          fields: [],
        });

      mockRevokeToken.mockResolvedValueOnce();

      await rotatePortalToken(
        merchantId,
        "old-token",
        now + 3600,
        { expirySeconds: 7200 }
      );

      expect(mockRevokeToken).toHaveBeenCalled();
    });
  });
});
