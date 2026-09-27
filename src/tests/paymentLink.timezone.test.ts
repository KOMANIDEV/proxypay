/**
 * Tests for #644 – Payment Link Expiration Timezone Handling
 *
 * Validates that:
 *  - Valid IANA timezone names are accepted and stored
 *  - Invalid timezone strings are rejected with a 400
 *  - The expiresAt timestamp is a proper UTC value independent of timezone string
 *  - No timezone at all still works (backward-compatible default behaviour)
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { Request, Response } from "express";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCreate = jest.fn<any>();
const mockFindByToken = jest.fn<any>();

jest.mock("../models/paymentLink", () => ({
  PaymentLinkModel: jest.fn<any>().mockImplementation(() => ({
    create: mockCreate,
    findByToken: mockFindByToken,
  })),
}));

jest.mock("../models/transaction", () => ({
  TransactionModel: jest.fn<any>().mockImplementation(() => ({})),
  TransactionStatus: { Pending: "pending" },
}));

jest.mock("qrcode", () => ({
  toDataURL: jest.fn<any>().mockResolvedValue("data:image/png;base64,mock"),
}));

// ── Import controller after mocks ─────────────────────────────────────────────

import { createPaymentLinkHandler } from "../controllers/paymentLinkController";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(body: Record<string, unknown>): Partial<Request> {
  return {
    body,
    protocol: "https",
    get: jest.fn<any>().mockReturnValue("example.com"),
    user: { id: "merchant-001" },
  } as any;
}

function makeRes(): Partial<Response> {
  const res: Partial<Response> = {
    status: jest.fn<any>().mockReturnThis(),
    json: jest.fn<any>().mockReturnThis(),
  };
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createPaymentLinkHandler – timezone handling (#644)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const VALID_BODY = {
    amount: 5000,
    currency: "XAF",
    stellarAddress: "GABCDEF234567ABCDEF234567ABCDEF234567ABCDEF234567ABCDEF2",
    expiresIn: 86400, // 24 hours in seconds
  };

  it("accepts a valid IANA timezone and stores it on the payment link", async () => {
    const mockLink = {
      id: "link-tz-001",
      token: "tok123",
      timezone: "Africa/Lagos",
      expiresAt: new Date(Date.now() + 86400 * 1000),
    };
    mockCreate.mockResolvedValueOnce(mockLink);

    const req = makeReq({ ...VALID_BODY, timezone: "Africa/Lagos" });
    const res = makeRes();

    await createPaymentLinkHandler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(201);
    // createPaymentLink called with timezone
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "Africa/Lagos" }),
    );
  });

  it("accepts other valid IANA timezones (Europe/Paris, America/New_York)", async () => {
    const mockLink = { id: "l2", token: "t2", timezone: "Europe/Paris" };
    mockCreate.mockResolvedValue(mockLink);

    for (const tz of ["Europe/Paris", "America/New_York", "Asia/Kolkata"]) {
      jest.clearAllMocks();
      mockCreate.mockResolvedValueOnce({ ...mockLink, timezone: tz });

      const req = makeReq({ ...VALID_BODY, timezone: tz });
      const res = makeRes();

      await createPaymentLinkHandler(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: tz }),
      );
    }
  });

  it("returns 400 for an unrecognised timezone string", async () => {
    const req = makeReq({ ...VALID_BODY, timezone: "Not/A/Real/Timezone" });
    const res = makeRes();

    await createPaymentLinkHandler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    const jsonArg = (res.json as jest.Mock).mock.calls[0][0] as any;
    expect(jsonArg.error).toMatch(/Unknown timezone/i);
    // DB must NOT be touched
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty timezone string", async () => {
    const req = makeReq({ ...VALID_BODY, timezone: "" });
    const res = makeRes();

    await createPaymentLinkHandler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-string timezone", async () => {
    const req = makeReq({ ...VALID_BODY, timezone: 12345 });
    const res = makeRes();

    await createPaymentLinkHandler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("works without timezone (backward-compatible, no validation required)", async () => {
    const mockLink = { id: "link-no-tz", token: "tok456", timezone: null };
    mockCreate.mockResolvedValueOnce(mockLink);

    const req = makeReq(VALID_BODY); // no timezone field
    const res = makeRes();

    await createPaymentLinkHandler(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(201);
    // timezone should be undefined when not supplied
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: undefined }),
    );
  });

  it("stores a UTC expiresAt timestamp regardless of timezone", async () => {
    const mockLink = {
      id: "link-tz-exp",
      token: "tokexp",
      timezone: "Africa/Nairobi",
      expiresAt: new Date(Date.now() + 3600 * 1000),
    };
    mockCreate.mockResolvedValueOnce(mockLink);

    const before = Date.now();
    const req = makeReq({
      ...VALID_BODY,
      expiresIn: 3600,
      timezone: "Africa/Nairobi",
    });
    const res = makeRes();

    await createPaymentLinkHandler(req as Request, res as Response);

    const callArg = mockCreate.mock.calls[0][0] as any;
    expect(callArg.expiresAt).toBeInstanceOf(Date);
    // The stored timestamp should be ~1 hour from now (UTC)
    const diff = callArg.expiresAt.getTime() - before;
    expect(diff).toBeGreaterThan(3590 * 1000);
    expect(diff).toBeLessThan(3610 * 1000);
  });
});
