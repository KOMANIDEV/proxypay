import { runPaymentLinkExpirationJob } from "../../jobs/paymentLinkExpirationJob";

const mockFindExpiringSoon = jest.fn();
const mockFindExpired = jest.fn();
const mockHasExpirationNotificationBeenSent = jest.fn();
const mockRecordExpirationNotification = jest.fn();

jest.mock("../../models/paymentLink", () => ({
  PaymentLinkModel: jest.fn().mockImplementation(() => ({
    findExpiringSoon: mockFindExpiringSoon,
    findExpired: mockFindExpired,
    hasExpirationNotificationBeenSent: mockHasExpirationNotificationBeenSent,
    recordExpirationNotification: mockRecordExpirationNotification,
  })),
}));

jest.mock("../../models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue({
      id: "merchant-1",
      email: "merchant@test.com",
      displayName: "Test Merchant",
      preferredLanguage: "en",
    }),
  })),
}));

jest.mock("../../services/notificationRouter", () => ({
  NotificationRouter: jest.fn().mockImplementation(() => ({
    routeNotification: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../../utils/metrics", () => ({
  paymentLinkExpirationNotificationsTotal: { inc: jest.fn() },
}));

const makeExpiringLink = (hoursFromNow: number) => ({
  id: "link-1",
  merchantId: "merchant-1",
  amount: "100",
  currency: "XAF",
  description: "Test",
  token: "tok_abc123",
  isOneTime: false,
  isUsed: false,
  stellarAddress: "GABC123",
  expiresAt: new Date(Date.now() + hoursFromNow * 60 * 60 * 1000),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const makeExpiredLink = () => ({
  id: "link-expired",
  merchantId: "merchant-1",
  amount: "200",
  currency: "USDC",
  description: "Expired link",
  token: "tok_expired",
  isOneTime: false,
  isUsed: false,
  stellarAddress: "GDEF456",
  expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  createdAt: new Date(),
  updatedAt: new Date(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFindExpiringSoon.mockResolvedValue([]);
  mockFindExpired.mockResolvedValue([]);
  mockHasExpirationNotificationBeenSent.mockResolvedValue(false);
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("runPaymentLinkExpirationJob", () => {
  it("logs when no links are expiring or expired", async () => {
    await runPaymentLinkExpirationJob();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Found 0 links expiring soon"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Found 0 expired links"),
    );
  });

  it("sends warning for links expiring soon", async () => {
    const link = makeExpiringLink(12);
    mockFindExpiringSoon.mockResolvedValue([link]);

    await runPaymentLinkExpirationJob();
    expect(mockRecordExpirationNotification).toHaveBeenCalledWith(
      "link-1",
      "warning_24h",
    );
  });

  it("sends expired notification for expired links", async () => {
    const link = makeExpiredLink();
    mockFindExpired.mockResolvedValue([link]);

    await runPaymentLinkExpirationJob();
    expect(mockRecordExpirationNotification).toHaveBeenCalledWith(
      "link-expired",
      "expired",
    );
  });

  it("skips warning if already sent", async () => {
    const link = makeExpiringLink(12);
    mockFindExpiringSoon.mockResolvedValue([link]);
    mockHasExpirationNotificationBeenSent.mockResolvedValue(true);

    await runPaymentLinkExpirationJob();
    expect(mockRecordExpirationNotification).not.toHaveBeenCalled();
  });

  it("handles errors for individual links without failing the job", async () => {
    const goodLink = makeExpiringLink(10);
    const badLink = makeExpiringLink(5);
    mockFindExpiringSoon.mockResolvedValue([badLink, goodLink]);

    // Make first notification fail
    mockRecordExpirationNotification
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce(undefined);

    await runPaymentLinkExpirationJob();
    expect(console.error).toHaveBeenCalled();
    expect(mockRecordExpirationNotification).toHaveBeenCalledTimes(1);
  });

  it("processes both expiring and expired links", async () => {
    const expiring = makeExpiringLink(12);
    const expired = makeExpiredLink();
    mockFindExpiringSoon.mockResolvedValue([expiring]);
    mockFindExpired.mockResolvedValue([expired]);

    await runPaymentLinkExpirationJob();
    expect(mockRecordExpirationNotification).toHaveBeenCalledTimes(2);
  });
});
