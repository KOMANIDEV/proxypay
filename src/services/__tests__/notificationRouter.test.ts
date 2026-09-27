import { NotificationRouter, NotificationSeverity } from "../notificationRouter";
import { notificationDeduplicator } from "../notificationDeduplicator";
import { UserModel } from "../../models/users";
import { Transaction } from "../../models/transaction";

jest.mock("../email", () => {
  const mockEmailService = {
    sendEmail: jest.fn(),
    sendTransactionReceipt: jest.fn(),
    sendTransactionFailure: jest.fn(),
  };
  (global as any).mockEmailService = mockEmailService;
  return {
    emailService: mockEmailService,
  };
});

jest.mock("../sms", () => {
  const mockSmsService = {
    notifyTransactionEvent: jest.fn(),
  };
  (global as any).mockSmsService = mockSmsService;
  return {
    smsService: mockSmsService,
  };
});

jest.mock("../push", () => {
  const mockPushService = {
    sendToUser: jest.fn(),
    sendTransactionComplete: jest.fn(),
    sendTransactionFailed: jest.fn(),
  };
  (global as any).mockPushService = mockPushService;
  return {
    pushNotificationService: mockPushService,
  };
});

jest.mock("../whatsapp", () => {
  const mockWhatsappService = {
    notifyTransactionEvent: jest.fn(),
  };
  (global as any).mockWhatsappService = mockWhatsappService;
  return {
    whatsappService: mockWhatsappService,
  };
});

jest.mock("../pagerDutyService", () => {
  const mockPagerDutyService = {};
  (global as any).mockPagerDutyService = mockPagerDutyService;
  return {
    pagerDutyService: mockPagerDutyService,
  };
});

const mockEmailService = (global as any).mockEmailService;
const mockSmsService = (global as any).mockSmsService;
const mockPushService = (global as any).mockPushService;
const mockWhatsappService = (global as any).mockWhatsappService;
const mockPagerDutyService = (global as any).mockPagerDutyService;

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-1",
    referenceNumber: "REF-1",
    type: "deposit",
    amount: "100",
    phoneNumber: "+15551234567",
    provider: "mtn",
    status: "completed",
    userId: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("NotificationRouter", () => {
  let notificationRouter: NotificationRouter;
  let mockUserModel: jest.Mocked<UserModel>;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Mock UserModel
    mockUserModel = {
      findById: jest.fn(),
    } as any;

    notificationRouter = new NotificationRouter(mockUserModel);
    notificationDeduplicator.reset();
  });

  describe("routeNotification", () => {
    it("should route low severity notifications to push channel only", async () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      const context = {
        severity: "low" as NotificationSeverity,
        category: "test",
        title: "Test Notification",
        message: "Test message",
      };

      await notificationRouter.routeNotification(context);

      // Low-severity system notifications select push as the only channel.
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Routing low notification to channels: push",
        ),
      );
      expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
      expect(mockSmsService.notifyTransactionEvent).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe("deduplication", () => {
    beforeEach(() => {
      mockUserModel.findById.mockResolvedValue({
        email: "user@example.com",
        preferredLanguage: "en",
        displayName: "Test User",
      } as any);
    });

    it("sends a transaction notification only once for the same event", async () => {
      const transaction = makeTransaction();

      await notificationRouter.routeTransactionNotification(transaction, "completed");
      await notificationRouter.routeTransactionNotification(transaction, "completed");

      expect(mockEmailService.sendTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(mockSmsService.notifyTransactionEvent).toHaveBeenCalledTimes(1);
      expect(mockPushService.sendTransactionComplete).toHaveBeenCalledTimes(1);
    });

    it("sends distinct transaction events even within the dedup window", async () => {
      const transaction = makeTransaction();

      await notificationRouter.routeTransactionNotification(transaction, "completed");
      await notificationRouter.routeTransactionNotification(
        makeTransaction({ id: "tx-2", referenceNumber: "REF-2" }),
        "completed",
      );

      expect(mockEmailService.sendTransactionReceipt).toHaveBeenCalledTimes(2);
      expect(mockSmsService.notifyTransactionEvent).toHaveBeenCalledTimes(2);
      expect(mockPushService.sendTransactionComplete).toHaveBeenCalledTimes(2);
    });

    it("treats completed and failed as distinct events for the same transaction", async () => {
      const transaction = makeTransaction();

      await notificationRouter.routeTransactionNotification(transaction, "completed");
      await notificationRouter.routeTransactionNotification(
        transaction,
        "failed",
        "provider rejected",
      );

      expect(mockEmailService.sendTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(mockEmailService.sendTransactionFailure).toHaveBeenCalledTimes(1);
      expect(mockPushService.sendTransactionComplete).toHaveBeenCalledTimes(1);
      expect(mockPushService.sendTransactionFailed).toHaveBeenCalledTimes(1);
    });

    it("deduplicates system notifications that share the same entity", async () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      const context = {
        severity: "low" as NotificationSeverity,
        category: "subscription",
        title: "Subscription Created",
        message: "Subscription sub-1 created",
        data: { subscriptionId: "sub-1" },
      };

      await notificationRouter.routeNotification(context);
      await notificationRouter.routeNotification(context);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping duplicate notification"),
      );
      logSpy.mockRestore();
    });
  });
});
