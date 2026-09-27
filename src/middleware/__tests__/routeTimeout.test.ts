import { Request, Response, NextFunction } from "express";
import {
  routeTimeout,
  setRouteTimeoutOverride,
  deleteRouteTimeoutOverride,
  getRouteTimeoutOverrides,
  listTimeouts,
  updateTimeout,
} from "../middleware/routeTimeout";

describe("routeTimeout middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.useFakeTimers();
    req = {
      method: "GET",
      path: "/api/test",
      url: "/api/test",
      destroy: jest.fn(),
    };
    res = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      once: jest.fn(),
    };
    next = jest.fn();

    // Clear overrides
    for (const key of getRouteTimeoutOverrides().keys()) {
      deleteRouteTimeoutOverride(key);
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("calls next() and sets up timer for api preset", () => {
    const middleware = routeTimeout("api");
    middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.once).toHaveBeenCalledWith("finish", expect.any(Function));
    expect(res.once).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("returns 408 when timeout fires", () => {
    const middleware = routeTimeout("api");
    middleware(req as Request, res as Response, next);

    jest.advanceTimersByTime(5000);

    expect(res.status).toHaveBeenCalledWith(408);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "REQUEST_TIMEOUT",
        route: "GET /api/test",
      }),
    );
    expect(req.destroy).toHaveBeenCalled();
  });

  it("respects route overrides", () => {
    setRouteTimeoutOverride("GET /api/test", 2000);

    const middleware = routeTimeout("api");
    middleware(req as Request, res as Response, next);

    jest.advanceTimersByTime(1999);
    expect(res.status).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(res.status).toHaveBeenCalledWith(408);
  });

  it("cleans up timer on response finish", () => {
    const middleware = routeTimeout("api");
    middleware(req as Request, res as Response, next);

    // Simulate response finish
    const finishCb = (res.once as jest.Mock).mock.calls.find(
      (c: unknown[]) => c[0] === "finish",
    )?.[1];
    finishCb?.();

    jest.advanceTimersByTime(10000);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("listTimeouts", () => {
  it("returns timeout configuration", () => {
    const req = {} as Request;
    const res = {
      json: jest.fn(),
    } as unknown as Response;

    listTimeouts(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        defaults: expect.objectContaining({
          api: expect.any(Number),
          upload: expect.any(Number),
          batch: expect.any(Number),
        }),
        overrides: expect.any(Object),
      }),
    );
  });
});

describe("updateTimeout", () => {
  it("returns 400 for missing route", () => {
    const req = { body: {} } as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;

    updateTimeout(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("sets and removes timeout override", () => {
    const req = { body: { route: "GET /test", timeoutMs: 5000 } } as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;

    updateTimeout(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it("validates timeoutMs range", () => {
    const req = { body: { route: "GET /test", timeoutMs: 100 } } as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;

    updateTimeout(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
