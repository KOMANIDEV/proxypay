import {
  isTokenRevoked,
  revokeToken,
  getMerchantRevokedTokens,
  manuallyRevokeToken,
  revokeAllMerchantTokens,
  clearRevokedToken,
} from "../tokenRevocationService";
import { redisClient } from "../../config/redis";

// Mock Redis client
jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    setEx: jest.fn(),
    sAdd: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
    sMembers: jest.fn(),
  },
}));

const mockRedis = redisClient as jest.Mocked<typeof redisClient>;

describe("tokenRevocationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.isOpen = true;
  });

  describe("isTokenRevoked", () => {
    it("returns false for non-revoked token", async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      const result = await isTokenRevoked("token-123");
      expect(result).toBe(false);
      expect(mockRedis.get).toHaveBeenCalledWith("token:revoked:token-123");
    });

    it("returns true for revoked token", async () => {
      mockRedis.get.mockResolvedValueOnce(
        JSON.stringify({
          tokenId: "token-123",
          type: "portal",
          merchantId: "m1",
          revokedAt: 1000,
          reason: "rotation",
        })
      );
      const result = await isTokenRevoked("token-123");
      expect(result).toBe(true);
    });

    it("returns false when Redis is down", async () => {
      mockRedis.isOpen = false;
      const result = await isTokenRevoked("token-123");
      expect(result).toBe(false);
    });

    it("returns false on Redis error", async () => {
      mockRedis.get.mockRejectedValueOnce(new Error("Redis error"));
      const result = await isTokenRevoked("token-123");
      expect(result).toBe(false);
    });
  });

  describe("revokeToken", () => {
    it("revokes a token with correct TTL", async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 7200; // 2 hours from now
      const tokenId = "token-456";
      const merchantId = "m1";

      mockRedis.setEx.mockResolvedValueOnce("OK");
      mockRedis.sAdd.mockResolvedValueOnce(1);
      mockRedis.expire.mockResolvedValueOnce(1);

      await revokeToken(tokenId, merchantId, expiresAt, "rotation", "portal");

      // Check setEx was called with correct TTL (includes 60s buffer)
      const calls = mockRedis.setEx.mock.calls[0];
      expect(calls[0]).toBe("token:revoked:token-456");
      const entry = JSON.parse(calls[2]);
      expect(entry.tokenId).toBe(tokenId);
      expect(entry.merchantId).toBe(merchantId);
      expect(entry.reason).toBe("rotation");
      expect(entry.type).toBe("portal");

      // Verify TTL calculation is approximately correct (7200 + 60 = 7260)
      expect(calls[1]).toBeGreaterThan(7200);
      expect(calls[1]).toBeLessThanOrEqual(7261);
    });

    it("throws when Redis is unavailable", async () => {
      mockRedis.isOpen = false;
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        revokeToken("token-789", "m1", expiresAt, "rotation", "portal")
      ).rejects.toThrow("Redis unavailable");
    });

    it("tracks token in merchant's revoked set", async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 3600;
      const tokenId = "token-999";
      const merchantId = "m2";

      mockRedis.setEx.mockResolvedValueOnce("OK");
      mockRedis.sAdd.mockResolvedValueOnce(1);
      mockRedis.expire.mockResolvedValueOnce(1);

      await revokeToken(tokenId, merchantId, expiresAt, "manual_revoke", "api_key");

      expect(mockRedis.sAdd).toHaveBeenCalledWith(
        "merchant:tokens:m2",
        expect.stringContaining(tokenId)
      );
    });

    it("handles different revocation reasons", async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 3600;

      mockRedis.setEx.mockResolvedValueOnce("OK");
      mockRedis.sAdd.mockResolvedValueOnce(1);
      mockRedis.expire.mockResolvedValueOnce(1);

      await revokeToken("token-1", "m1", expiresAt, "compromise", "portal");

      const entry = JSON.parse(mockRedis.setEx.mock.calls[0][2]);
      expect(entry.reason).toBe("compromise");
    });
  });

  describe("getMerchantRevokedTokens", () => {
    it("returns empty array when no revoked tokens", async () => {
      mockRedis.sMembers.mockResolvedValueOnce([]);
      const result = await getMerchantRevokedTokens("m1");
      expect(result).toEqual([]);
    });

    it("returns list of revoked tokens for merchant", async () => {
      const tokens = [
        JSON.stringify({
          tokenId: "token-1",
          revokedAt: 1000,
          reason: "rotation",
        }),
        JSON.stringify({
          tokenId: "token-2",
          revokedAt: 2000,
          reason: "manual_revoke",
        }),
      ];
      mockRedis.sMembers.mockResolvedValueOnce(tokens);

      const result = await getMerchantRevokedTokens("m1");

      expect(result).toHaveLength(2);
      expect(result[0].tokenId).toBe("token-1");
      expect(result[1].tokenId).toBe("token-2");
    });

    it("returns empty array when Redis is down", async () => {
      mockRedis.isOpen = false;
      const result = await getMerchantRevokedTokens("m1");
      expect(result).toEqual([]);
    });

    it("handles Redis error gracefully", async () => {
      mockRedis.sMembers.mockRejectedValueOnce(new Error("Redis error"));
      const result = await getMerchantRevokedTokens("m1");
      expect(result).toEqual([]);
    });
  });

  describe("manuallyRevokeToken", () => {
    it("revokes token with manual_revoke reason", async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 3600;

      mockRedis.setEx.mockResolvedValueOnce("OK");
      mockRedis.sAdd.mockResolvedValueOnce(1);
      mockRedis.expire.mockResolvedValueOnce(1);

      await manuallyRevokeToken("token-abc", "m1", expiresAt, "User requested");

      const entry = JSON.parse(mockRedis.setEx.mock.calls[0][2]);
      expect(entry.reason).toBe("manual_revoke");
    });
  });

  describe("revokeAllMerchantTokens", () => {
    it("revokes all tokens for a merchant", async () => {
      const revoked = [
        JSON.stringify({
          tokenId: "token-1",
          revokedAt: 1000,
          reason: "rotation",
        }),
        JSON.stringify({
          tokenId: "token-2",
          revokedAt: 2000,
          reason: "rotation",
        }),
      ];
      mockRedis.sMembers.mockResolvedValueOnce(revoked);
      mockRedis.del.mockResolvedValueOnce(1);

      await revokeAllMerchantTokens("m1", "compromise");

      expect(mockRedis.del).toHaveBeenCalledWith("merchant:tokens:m1");
    });

    it("throws when Redis is unavailable", async () => {
      mockRedis.isOpen = false;

      await expect(revokeAllMerchantTokens("m1")).rejects.toThrow(
        "Redis unavailable"
      );
    });
  });

  describe("clearRevokedToken", () => {
    it("clears a revoked token entry", async () => {
      mockRedis.del.mockResolvedValueOnce(1);

      await clearRevokedToken("token-xyz");

      expect(mockRedis.del).toHaveBeenCalledWith("token:revoked:token-xyz");
    });

    it("handles gracefully when Redis is down", async () => {
      mockRedis.isOpen = false;

      // Should not throw
      await clearRevokedToken("token-xyz");

      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });
});
