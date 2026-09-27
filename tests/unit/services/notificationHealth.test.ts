/**
 * #479 – Real-Time Notification System Status
 *
 * Covers the parts that are pure logic (health classification, the aggregate
 * verdict) and the parts that need the database mocked (delivery recording,
 * health aggregation, the status endpoint's HTTP semantics).
 */

jest.mock("../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../src/utils/metrics", () => ({
  notificationDeliveriesTotal: { labels: () => ({ inc: jest.fn() }) },
  notificationDeliveryDurationSeconds: {
    labels: () => ({ observe: jest.fn() }),
  },
  notificationChannelHealthGauge: { labels: () => ({ set: jest.fn() }) },
  notificationSystemUp: { set: jest.fn() },
}));

jest.mock("../src/utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { queryRead, queryWrite } from "../src/config/database";
import {
  NOTIFICATION_CHANNELS,
  classifyChannel,
  getChannelHealth,
  getFailingChannels,
  getSystemStatus,
  recordDelivery,
} from "../src/services/notificationHealthService";

const mockRead = queryRead as jest.Mock;
const mockWrite = queryWrite as jest.Mock;

function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    channel: "email",
    attempts: "20",
    success_count: "20",
    failure_count: "0",
    avg_duration_ms: "120.5",
    last_error: null,
    last_success_at: new Date("2026-09-01T10:00:00Z"),
    last_failure_at: null,
    ...overrides,
  };
}

describe("notification system status (#479)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("classifyChannel", () => {
    it("marks a fully successful channel healthy", () => {
      expect(classifyChannel(1, 10)).toBe("healthy");
    });

    it("marks a channel below the degraded threshold as degraded", () => {
      expect(classifyChannel(0.9, 10)).toBe("degraded");
    });

    it("marks a channel at or below the down threshold as down", () => {
      expect(classifyChannel(0.4, 10)).toBe("down");
    });

    it("treats the degraded threshold as inclusive of healthy", () => {
      // 0.95 is the configured floor: exactly at it is still healthy.
      expect(classifyChannel(0.95, 100)).toBe("healthy");
      expect(classifyChannel(0.9499, 100)).toBe("degraded");
    });

    it("marks a channel with no traffic as down, not healthy", () => {
      // A channel that was never wired up must not report as healthy.
      expect(classifyChannel(0, 0)).toBe("down");
      expect(classifyChannel(1, 0)).toBe("down");
    });
  });

  describe("getFailingChannels", () => {
    it("returns only the unhealthy channels", () => {
      const failing = getFailingChannels([
        { channel: "email", status: "healthy" },
        { channel: "sms", status: "degraded" },
        { channel: "push", status: "down" },
        { channel: "whatsapp", status: "healthy" },
        { channel: "pagerduty", status: "degraded" },
      ] as never);

      expect(failing).toEqual(["sms", "push", "pagerduty"]);
    });

    it("returns an empty list when everything is healthy", () => {
      expect(
        getFailingChannels([{ channel: "email", status: "healthy" }] as never),
      ).toEqual([]);
    });
  });

  describe("recordDelivery", () => {
    it("persists a successful delivery with delivered_at set", async () => {
      mockWrite.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recordDelivery({
        notificationKey: "txn:123",
        channel: "email",
        status: "delivered",
        durationMs: 85,
        category: "transaction",
        userId: "user-1",
        transactionId: "123",
      });

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const [sql, params] = mockWrite.mock.calls[0];
      expect(sql).toContain("INSERT INTO notification_deliveries");
      expect(params).toEqual([
        "txn:123",
        "email",
        "transaction",
        undefined,
        "user-1",
        "123",
        "delivered",
        85,
        null,
      ]);
    });

    it("stores the error message on failure", async () => {
      mockWrite.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recordDelivery({
        notificationKey: "txn:456",
        channel: "sms",
        status: "failed",
        durationMs: 5000,
        errorMessage: "SMTP connection refused",
      });

      const params = mockWrite.mock.calls[0][1];
      expect(params[8]).toBe("SMTP connection refused");
    });

    it("never throws when the tracking write fails", async () => {
      // The router is on the delivery hot path: a broken tracking insert must
      // not surface as a failed notification.
      mockWrite.mockRejectedValueOnce(new Error("connection terminated"));

      await expect(
        recordDelivery({
          notificationKey: "txn:789",
          channel: "push",
          status: "delivered",
          durationMs: 10,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("getChannelHealth", () => {
    it("returns every configured channel, including silent ones", async () => {
      mockRead.mockResolvedValueOnce({ rows: [aggregateRow()] });

      const health = await getChannelHealth(24);

      expect(health).toHaveLength(NOTIFICATION_CHANNELS.length);
      expect(health.map((c) => c.channel).sort()).toEqual(
        [...NOTIFICATION_CHANNELS].sort(),
      );
    });

    it("computes the success rate from the aggregates", async () => {
      mockRead.mockResolvedValueOnce({
        rows: [
          aggregateRow({
            channel: "sms",
            attempts: "10",
            success_count: "7",
            failure_count: "3",
          }),
        ],
      });

      const [sms] = (await getChannelHealth(24)).filter(
        (c) => c.channel === "sms",
      );

      expect(sms.attempts).toBe(10);
      expect(sms.successCount).toBe(7);
      expect(sms.failureCount).toBe(3);
      expect(sms.successRate).toBe(0.7);
      expect(sms.status).toBe("degraded");
      expect(sms.avgDurationMs).toBe(121); // rounded
    });

    it("reports a channel with no rows in the window as down", async () => {
      mockRead.mockResolvedValueOnce({ rows: [] });

      const health = await getChannelHealth(24);
      expect(health.every((c) => c.status === "down")).toBe(true);
      expect(health.every((c) => c.attempts === 0)).toBe(true);
    });

    it("passes the window through as an interval parameter", async () => {
      mockRead.mockResolvedValueOnce({ rows: [] });

      await getChannelHealth(48);

      expect(mockRead.mock.calls[0][1]).toEqual(["48"]);
    });
  });

  describe("getSystemStatus", () => {
    it("reports healthy when every channel has traffic and no failures", async () => {
      mockRead.mockResolvedValueOnce({
        rows: NOTIFICATION_CHANNELS.map((channel) =>
          aggregateRow({ channel }),
        ),
      });

      const status = await getSystemStatus(24);

      expect(status.status).toBe("healthy");
      expect(status.failingChannels).toEqual([]);
      expect(status.overallSuccessRate).toBe(1);
    });

    it("reports down when a single channel is down", async () => {
      mockRead.mockResolvedValueOnce({
        rows: [
          ...NOTIFICATION_CHANNELS.filter((c) => c !== "sms").map((channel) =>
            aggregateRow({ channel }),
          ),
          aggregateRow({
            channel: "sms",
            attempts: "10",
            success_count: "0",
            failure_count: "10",
            last_error: "SMTP relay unreachable",
          }),
        ],
      });

      const status = await getSystemStatus(24);

      // One broken provider means notifications are not fully working.
      expect(status.status).toBe("down");
      expect(status.failingChannels).toEqual(["sms"]);
    });

    it("reports degraded when no channel is fully down", async () => {
      mockRead.mockResolvedValueOnce({
        rows: [
          ...NOTIFICATION_CHANNELS.map((channel) =>
            aggregateRow({
              channel,
              attempts: "100",
              success_count: "80",
              failure_count: "20",
            }),
          ),
        ],
      });

      const status = await getSystemStatus(24);

      expect(status.status).toBe("degraded");
      expect(status.failingChannels).toHaveLength(NOTIFICATION_CHANNELS.length);
    });

    it("aggregates the overall success rate across channels", async () => {
      mockRead.mockResolvedValueOnce({
        rows: [
          aggregateRow({ channel: "email", attempts: "10", success_count: "10" }),
          aggregateRow({ channel: "sms", attempts: "10", success_count: "5" }),
        ],
      });

      const status = await getSystemStatus(24);

      // 15 of 20 deliveries succeeded.
      expect(status.overallSuccessRate).toBe(0.75);
      expect(status.totalAttempts).toBe(20);
    });
  });
});
