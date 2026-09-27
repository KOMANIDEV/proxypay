import {
  sessionTimeoutMiddleware,
  terminateSessionMiddleware,
  getSessionTimeoutForTier,
} from "../../middleware/sessionTimeout";

jest.mock("../../config/redis", () => ({
  redisClient: {
    hGetAll: jest.fn().mockResolvedValue({}),
    hSet: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
  },
}));

import { redisClient } from "../../config/redis";

beforeEach(() => {
  jest.clearAllMocks();
  (redisClient.hGetAll as jest.Mock).mockResolvedValue({});
  process.env.SESSION_IDLE_TIMEOUT_FREE = "1800";
  process.env.SESSION_IDLE_TIMEOUT_PRO = "3600";
  process.env.SESSION_IDLE_TIMEOUT_ENTERPRISE = "7200";
  process.env.SESSION_WARNING_SECONDS = "300";
});

describe("getSessionTimeoutForTier", () => {
  it("returns correct timeout for free tier", () => {
    expect(getSessionTimeoutForTier("free")).toBe(1800);
  });

  it("returns correct timeout for pro tier", () => {
    expect(getSessionTimeoutForTier("pro")).toBe(3600);
  });

  it("returns correct timeout for enterprise tier", () => {
    expect(getSessionTimeoutForTier("enterprise")).toBe(7200);
  });
});

describe("sessionTimeoutMiddleware", () => {
  let req: any;
  let res: any;
  let next: jest.Mock;

  beforeEach(() => {
    req = {
      method: "GET",
      path: "/api/test",
      ip: "127.0.0.1",
      header: jest.fn(),
      socket: { remoteAddress: "127.0.0.1" },
    };
    res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it("calls next for new sessions", async () => {
    const middleware = sessionTimeoutMiddleware();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("sets timeout headers", async () => {
    const middleware = sessionTimeoutMiddleware();
    await middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-Session-Timeout",
      expect.any(String),
    );
  });

  it("returns 401 when session is expired", async () => {
    // Mock an expired session
    (redisClient.hGetAll as jest.Mock).mockResolvedValue({
      lastActivity: String(Date.now() - 3600000),
      timeoutAt: String(Date.now() - 1000),
      warningSent: "false",
      tier: "free",
    });

    const middleware = sessionTimeoutMiddleware();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Session expired",
        code: "SESSION_TIMEOUT",
      }),
    );
  });

  it("sends warning when within warning period", async () => {
    // Mock a session that will expire in 200 seconds (within 300s warning)
    const timeoutAt = Date.now() + 200 * 1000;
    (redisClient.hGetAll as jest.Mock).mockResolvedValue({
      lastActivity: String(Date.now() - 1000),
      timeoutAt: String(timeoutAt),
      warningSent: "false",
      tier: "free",
    });

    const middleware = sessionTimeoutMiddleware();
    await middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith("X-Session-Timeout-Warning", "true");
    expect(next).toHaveBeenCalled();
  });

  it("does not send duplicate warnings", async () => {
    const timeoutAt = Date.now() + 200 * 1000;
    (redisClient.hGetAll as jest.Mock).mockResolvedValue({
      lastActivity: String(Date.now() - 1000),
      timeoutAt: String(timeoutAt),
      warningSent: "true",
      tier: "free",
    });

    const middleware = sessionTimeoutMiddleware();
    await middleware(req, res, next);
    expect(res.setHeader).not.toHaveBeenCalledWith(
      "X-Session-Timeout-Warning",
      "true",
    );
  });

  it("resets warning on refresh request", async () => {
    req.method = "POST";
    req.path = "/api/auth/refresh";

    const timeoutAt = Date.now() + 200 * 1000;
    (redisClient.hGetAll as jest.Mock).mockResolvedValue({
      lastActivity: String(Date.now() - 1000),
      timeoutAt: String(timeoutAt),
      warningSent: "true",
      tier: "free",
    });

    const middleware = sessionTimeoutMiddleware();
    await middleware(req, res, next);
    // Warning should be reset (warningSent set to false in Redis)
    expect(redisClient.hSet).toHaveBeenCalled();
  });
});

describe("terminateSessionMiddleware", () => {
  it("deletes session from Redis on logout", async () => {
    const req: any = {
      method: "POST",
      path: "/api/auth/logout",
      jwtUser: { userId: "user-123" },
      header: jest.fn(),
    };
    const res: any = {};
    const next = jest.fn();

    const middleware = terminateSessionMiddleware();
    await middleware(req, res, next);
    expect(redisClient.del).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("calls next even if no session to delete", async () => {
    const req: any = { method: "POST", path: "/logout", header: jest.fn() };
    const res: any = {};
    const next = jest.fn();

    const middleware = terminateSessionMiddleware();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
