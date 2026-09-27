import { Request, Response, NextFunction } from "express";
import {
  verifyPortalTokenNotRevoked,
  attachPortalTokenId,
} from "../portalTokenRevocation";
import { isTokenRevoked } from "../../services/tokenRevocationService";

jest.mock("../../services/tokenRevocationService", () => ({
  isTokenRevoked: jest.fn(),
}));

const mockIsTokenRevoked = isTokenRevoked as jest.MockedFunction<
  typeof isTokenRevoked
>;

describe("portalTokenRevocation middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    jest.clearAllMocks();

    req = {
      headers: {},
      query: {},
      path: "/test",
      method: "GET",
      ip: "127.0.0.1",
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();
  });

  describe("verifyPortalTokenNotRevoked", () => {
    it("calls next() when no token present", async () => {
      await verifyPortalTokenNotRevoked(
        req as Request,
        res as Response,
        next
      );

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("calls next() when token is not revoked", async () => {
      const payload = {
        jti: "token-123",
        merchantId: "m1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

      req.headers = { authorization: `Bearer ${token}` };
      mockIsTokenRevoked.mockResolvedValueOnce(false);

      await verifyPortalTokenNotRevoked(
        req as Request,
        res as Response,
        next
      );

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(mockIsTokenRevoked).toHaveBeenCalledWith("token-123");
    });

    it("returns 401 when token is revoked", async () => {
      const payload = {
        jti: "token-revoked",
        merchantId: "m1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

      req.headers = { authorization: `Bearer ${token}` };
      mockIsTokenRevoked.mockResolvedValueOnce(true);

      await verifyPortalTokenNotRevoked(
        req as Request,
        res as Response,
        next
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Token has been revoked",
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("checks x-portal-token header", async () => {
      const payload = {
        jti: "token-header",
        merchantId: "m1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

      req.headers = { "x-portal-token": token };
      mockIsTokenRevoked.mockResolvedValueOnce(false);

      await verifyPortalTokenNotRevoked(
        req as Request,
        res as Response,
        next
      );

      expect(mockIsTokenRevoked).toHaveBeenCalledWith("token-header");
      expect(next).toHaveBeenCalled();
    });

    it("checks query parameter", async () => {
      const payload = {
        jti: "token-query",
        merchantId: "m1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

      req.query = { token };
      mockIsTokenRevoked.mockResolvedValueOnce(false);

      await verifyPortalTokenNotRevoked(
        req as Request,
        res as Response,
        next
      );

      expect(mockIsTokenRevoked).toHaveBeenCalledWith("token-query");
      expect(next).toHaveBeenCalled();
    });

    it("continues on token parsing error", async () => {
      req.headers = { authorization: "Bearer invalid.token" };

      await verifyPortalTokenNotRevoked(
        req as Request,
        res as Response,
        next
      );

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("continues on Redis error", async () => {
      const payload = {
        jti: "token-123",
        merchantId: "m1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

      req.headers = { authorization: `Bearer ${token}` };
      mockIsTokenRevoked.mockRejectedValueOnce(new Error("Redis error"));

      await verifyPortalTokenNotRevoked(
        req as Request,
        res as Response,
        next
      );

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("attachPortalTokenId", () => {
    it("extracts and attaches token ID from Bearer token", async () => {
      const payload = {
        jti: "token-123",
        merchantId: "m1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

      req.headers = { authorization: `Bearer ${token}` };

      await attachPortalTokenId(
        req as Request,
        res as Response,
        next
      );

      expect((req as any).portalTokenId).toBe("token-123");
      expect((req as any).portalTokenMerchantId).toBe("m1");
      expect(next).toHaveBeenCalled();
    });

    it("extracts token ID from x-portal-token header", async () => {
      const payload = {
        jti: "token-header",
        merchantId: "m2",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

      req.headers = { "x-portal-token": token };

      await attachPortalTokenId(
        req as Request,
        res as Response,
        next
      );

      expect((req as any).portalTokenId).toBe("token-header");
      expect((req as any).portalTokenMerchantId).toBe("m2");
      expect(next).toHaveBeenCalled();
    });

    it("extracts token ID from query parameter", async () => {
      const payload = {
        jti: "token-query",
        merchantId: "m3",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

      req.query = { token };

      await attachPortalTokenId(
        req as Request,
        res as Response,
        next
      );

      expect((req as any).portalTokenId).toBe("token-query");
      expect((req as any).portalTokenMerchantId).toBe("m3");
      expect(next).toHaveBeenCalled();
    });

    it("silently ignores when no token present", async () => {
      await attachPortalTokenId(
        req as Request,
        res as Response,
        next
      );

      expect((req as any).portalTokenId).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it("silently ignores parsing errors", async () => {
      req.headers = { authorization: "Bearer malformed.token.structure" };

      await attachPortalTokenId(
        req as Request,
        res as Response,
        next
      );

      expect((req as any).portalTokenId).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it("continues on error", async () => {
      req.headers = { authorization: "Bearer " };

      await attachPortalTokenId(
        req as Request,
        res as Response,
        next
      );

      expect(next).toHaveBeenCalled();
    });
  });
});
