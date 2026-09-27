/**
 * Controller tests for the merchant filter on transaction search (issue #621).
 *
 * A merchant may only search its own transactions; admins may search any
 * merchant or a batch of merchants in one request.
 */

import express from "express";
import request from "supertest";

const mockSearchByPhoneNumber = jest.fn();

jest.mock("../../src/services/stellar/stellarService", () => ({
  StellarService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../src/services/kyc/kycService", () => ({
  KYCService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock(
  "../../src/services/transactionLimit/transactionLimitService",
  () => ({
    TransactionLimitService: jest.fn().mockImplementation(() => ({})),
  }),
);

jest.mock("../../src/models/transaction", () => {
  const actual = jest.requireActual("../../src/models/transaction");
  return {
    ...actual,
    TransactionModel: jest.fn().mockImplementation(() => ({
      searchByPhoneNumber: (...args: unknown[]) =>
        mockSearchByPhoneNumber(...args),
    })),
  };
});

jest.mock("../../src/middleware/timeout", () => ({
  TimeoutPresets: {
    quick: (_req: unknown, _res: unknown, next: () => void) => next(),
    long: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  haltOnTimedout: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { transactionRoutes } from "../../src/routes/transactions";

function errorHandler(
  err: any,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) {
  const status = err.statusCode ?? err.status ?? 500;
  res.status(status).json({ error: err.message });
}

function createApp(user?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());

  if (user) {
    app.use((req, _res, next) => {
      (req as any).user = user;
      next();
    });
  }

  app.use("/api/transactions", transactionRoutes);
  app.use(errorHandler);
  return app;
}

describe("Transaction search merchant filter (#621)", () => {
  beforeEach(() => {
    mockSearchByPhoneNumber.mockReset();
    mockSearchByPhoneNumber.mockResolvedValue({ transactions: [], total: 0 });
  });

  it("lets a merchant search their own transactions", async () => {
    const res = await request(
      createApp({ id: "merchant-1", role: "merchant" }),
    ).get(
      "/api/transactions/search?phoneNumber=237600000000&merchant_id=merchant-1",
    );

    expect(res.status).toBe(200);
    expect(mockSearchByPhoneNumber).toHaveBeenCalledWith(
      "237600000000",
      50,
      0,
      ["merchant-1"],
    );
    expect(res.body.filters).toEqual({ merchantIds: ["merchant-1"] });
  });

  it("rejects a merchant searching another merchant", async () => {
    const res = await request(
      createApp({ id: "merchant-1", role: "merchant" }),
    ).get(
      "/api/transactions/search?phoneNumber=237600000000&merchantId=merchant-2",
    );

    expect(res.status).toBe(403);
    expect(mockSearchByPhoneNumber).not.toHaveBeenCalled();
  });

  it("rejects a batch that includes another merchant", async () => {
    const res = await request(
      createApp({ id: "merchant-1", role: "merchant" }),
    ).get(
      "/api/transactions/search?phoneNumber=237600000000&merchantIds=merchant-1,merchant-2",
    );

    expect(res.status).toBe(403);
    expect(mockSearchByPhoneNumber).not.toHaveBeenCalled();
  });

  it("lets an admin search several merchants in one query", async () => {
    const res = await request(createApp({ id: "admin-1", role: "admin" })).get(
      "/api/transactions/search?phoneNumber=237600000000&merchantIds=merchant-1,merchant-2",
    );

    expect(res.status).toBe(200);
    expect(mockSearchByPhoneNumber).toHaveBeenCalledWith(
      "237600000000",
      50,
      0,
      ["merchant-1", "merchant-2"],
    );
  });

  it("requires authentication when a merchant filter is supplied", async () => {
    const res = await request(createApp()).get(
      "/api/transactions/search?phoneNumber=237600000000&merchant_id=merchant-1",
    );

    expect(res.status).toBe(401);
    expect(mockSearchByPhoneNumber).not.toHaveBeenCalled();
  });

  it("keeps the previous three-argument call when no merchant filter is used", async () => {
    const res = await request(
      createApp({ id: "merchant-1", role: "merchant" }),
    ).get("/api/transactions/search?phoneNumber=237600000000");

    expect(res.status).toBe(200);
    expect(mockSearchByPhoneNumber).toHaveBeenCalledWith("237600000000", 50, 0);
    expect(res.body.filters).toBeUndefined();
  });
});
