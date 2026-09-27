/**
 * tests/jobs/providerTokenWatchdog.test.ts
 *
 * Tests for the provider token watchdog job — detection of expired/revoked
 * mobile money credentials and dead/stale accounting OAuth tokens, with
 * PagerDuty (critical) and webhook (warning) alerting.
 */

import {
  runProviderTokenWatchdogJob,
  _resetWatchdogState,
} from "../../src/jobs/providerTokenWatchdog";
import { MTNProvider } from "../../src/services/mobilemoney/providers/mtn";
import { AirtelService } from "../../src/services/mobilemoney/providers/airtel";
import { OrangeProvider } from "../../src/services/mobilemoney/providers/orange";
import { AccountingService } from "../../src/services/accounting";

jest.mock("../../src/services/mobilemoney/providers/mtn", () => ({
  MTNProvider: jest.fn(),
}));
jest.mock("../../src/services/mobilemoney/providers/airtel", () => ({
  AirtelService: jest.fn(),
}));
jest.mock("../../src/services/mobilemoney/providers/orange", () => ({
  OrangeProvider: jest.fn(),
}));
jest.mock("../../src/services/accounting", () => ({
  AccountingProvider: { QUICKBOOKS: "quickbooks", XERO: "xero" },
  AccountingService: jest.fn(),
}));

const MockMTNProvider = MTNProvider as jest.Mock;
const MockAirtelService = AirtelService as jest.Mock;
const MockOrangeProvider = OrangeProvider as jest.Mock;
const MockAccountingService = AccountingService as jest.Mock;

describe("providerTokenWatchdog", () => {
  let mtnCheckAuth: jest.Mock;
  let airtelCheckAuth: jest.Mock;
  let orangeCheckAuth: jest.Mock;
  let accountingServiceMock: {
    getAllActiveConnections: jest.Mock;
    refreshXeroToken: jest.Mock;
    refreshQuickBooksToken: jest.Mock;
  };

  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  function connection(overrides: Record<string, unknown> = {}): any {
    return {
      id: "conn-1",
      provider: "xero",
      expiresAt: new Date(now + 3600 * 1000),
      updatedAt: new Date(now - 10 * DAY_MS),
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    _resetWatchdogState();

    process.env.PAGERDUTY_INTEGRATION_KEY = "test-pagerduty-key";
    delete process.env.PAGERDUTY_DEDUP_KEY;
    delete process.env.PROVIDER_TOKEN_ALERT_WEBHOOK_URL;
    delete process.env.SLACK_ALERTS_WEBHOOK_URL;
    delete process.env.PROVIDER_TOKEN_STALE_REALERT_HOURS;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
    } as Response);

    mtnCheckAuth = jest.fn().mockResolvedValue({ success: true });
    airtelCheckAuth = jest.fn().mockResolvedValue({ success: true });
    orangeCheckAuth = jest.fn().mockResolvedValue({ success: true });

    MockMTNProvider.mockImplementation(() => ({ checkAuth: mtnCheckAuth }));
    MockAirtelService.mockImplementation(() => ({ checkAuth: airtelCheckAuth }));
    MockOrangeProvider.mockImplementation(() => ({ checkAuth: orangeCheckAuth }));

    accountingServiceMock = {
      getAllActiveConnections: jest.fn().mockResolvedValue([]),
      refreshXeroToken: jest.fn().mockResolvedValue(undefined),
      refreshQuickBooksToken: jest.fn().mockResolvedValue(undefined),
    };
    MockAccountingService.mockImplementation(() => accountingServiceMock);
  });

  afterEach(() => {
    delete process.env.PAGERDUTY_INTEGRATION_KEY;
  });

  describe("mobile money credential probes", () => {
    it("probes all three providers and stays silent when credentials are valid", async () => {
      await runProviderTokenWatchdogJob();

      expect(mtnCheckAuth).toHaveBeenCalledTimes(1);
      expect(airtelCheckAuth).toHaveBeenCalledTimes(1);
      expect(orangeCheckAuth).toHaveBeenCalledTimes(1);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("triggers a CRITICAL PagerDuty incident when a provider rejects credentials (401/403)", async () => {
      mtnCheckAuth.mockResolvedValue({
        success: false,
        invalidCredentials: true,
        error: new Error("MTN token request failed with status 401"),
      });

      await runProviderTokenWatchdogJob();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe("https://events.pagerduty.com/v2/enqueue");

      const body = JSON.parse(init.body);
      expect(body.event_action).toBe("trigger");
      expect(body.dedup_key).toBe(
        "proxypay-token-watchdog-mtn-credentials",
      );
      expect(body.payload.severity).toBe("critical");
      expect(body.payload.summary).toContain(
        "MTN credentials expired or revoked",
      );
      expect(body.payload.custom_details.status).toBe("invalid_credentials");
    });

    it("does not page repeatedly while the credential incident is active", async () => {
      mtnCheckAuth.mockResolvedValue({
        success: false,
        invalidCredentials: true,
      });

      await runProviderTokenWatchdogJob();
      await runProviderTokenWatchdogJob();

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("resolves the credential incident once credentials are accepted again", async () => {
      mtnCheckAuth.mockResolvedValue({
        success: false,
        invalidCredentials: true,
      });

      await runProviderTokenWatchdogJob();
      expect(global.fetch).toHaveBeenCalledTimes(1);

      mtnCheckAuth.mockResolvedValue({ success: true });
      await runProviderTokenWatchdogJob();

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const [, init] = (global.fetch as jest.Mock).mock.calls[1];
      const body = JSON.parse(init.body);
      expect(body.event_action).toBe("resolve");
      expect(body.dedup_key).toBe(
        "proxypay-token-watchdog-mtn-credentials",
      );
    });

    it("ignores unreachable providers (uptime watchdog owns those)", async () => {
      mtnCheckAuth.mockResolvedValue({
        success: false,
        error: new Error("ECONNREFUSED"),
      });

      await runProviderTokenWatchdogJob();

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("accounting token checks", () => {
    it("does nothing when there are no active connections", async () => {
      await runProviderTokenWatchdogJob();

      expect(accountingServiceMock.getAllActiveConnections).toHaveBeenCalledTimes(1);
      expect(accountingServiceMock.refreshXeroToken).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("auto-heals an expired access token when the refresh succeeds", async () => {
      accountingServiceMock.getAllActiveConnections.mockResolvedValue([
        connection({ provider: "xero", expiresAt: new Date(now - 1000) }),
      ]);

      await runProviderTokenWatchdogJob();

      expect(accountingServiceMock.refreshXeroToken).toHaveBeenCalledWith(
        "conn-1",
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("pages for manual re-authorization when the expired token refresh fails", async () => {
      accountingServiceMock.getAllActiveConnections.mockResolvedValue([
        connection({ provider: "quickbooks", expiresAt: new Date(now - 1000) }),
      ]);
      accountingServiceMock.refreshQuickBooksToken.mockRejectedValue(
        new Error("QuickBooks token refresh failed: invalid_grant"),
      );

      await runProviderTokenWatchdogJob();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe("https://events.pagerduty.com/v2/enqueue");

      const body = JSON.parse(init.body);
      expect(body.event_action).toBe("trigger");
      expect(body.dedup_key).toBe(
        "proxypay-token-watchdog-accounting-conn-1-reauth",
      );
      expect(body.payload.summary).toContain(
        "manual re-authorization required",
      );
      expect(body.payload.custom_details.error).toContain("invalid_grant");
    });

    it("stops retrying a connection whose re-authorization incident is active", async () => {
      accountingServiceMock.getAllActiveConnections.mockResolvedValue([
        connection({ expiresAt: new Date(now - 1000) }),
      ]);
      accountingServiceMock.refreshXeroToken.mockRejectedValue(
        new Error("Xero token refresh failed"),
      );

      await runProviderTokenWatchdogJob();
      await runProviderTokenWatchdogJob();

      expect(accountingServiceMock.refreshXeroToken).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("resolves the re-authorization incident once the connection heals", async () => {
      accountingServiceMock.getAllActiveConnections.mockResolvedValue([
        connection({ expiresAt: new Date(now - 1000) }),
      ]);
      accountingServiceMock.refreshXeroToken.mockRejectedValue(
        new Error("Xero token refresh failed"),
      );

      await runProviderTokenWatchdogJob();
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Connection is reconnected via the OAuth flow → token fresh again
      accountingServiceMock.getAllActiveConnections.mockResolvedValue([
        connection({ expiresAt: new Date(now + 3600 * 1000) }),
      ]);
      await runProviderTokenWatchdogJob();

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const [, init] = (global.fetch as jest.Mock).mock.calls[1];
      const body = JSON.parse(init.body);
      expect(body.event_action).toBe("resolve");
      expect(body.dedup_key).toBe(
        "proxypay-token-watchdog-accounting-conn-1-reauth",
      );
    });

    it("warns via webhook when a refresh token is approaching inactivity expiry", async () => {
      process.env.PROVIDER_TOKEN_ALERT_WEBHOOK_URL =
        "https://webhook.example.com/token-alert";

      // Xero refresh tokens expire after 60 days; updatedAt 50 days ago
      accountingServiceMock.getAllActiveConnections.mockResolvedValue([
        connection({ provider: "xero", updatedAt: new Date(now - 50 * DAY_MS) }),
      ]);

      await runProviderTokenWatchdogJob();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe("https://webhook.example.com/token-alert");

      const body = JSON.parse(init.body);
      expect(body.alertType).toBe("provider_token_stale");
      expect(body.severity).toBe("warning");
      expect(body.connections[0]).toMatchObject({
        connectionId: "conn-1",
        provider: "xero",
        daysSinceRefresh: 50,
        refreshTokenLimitDays: 60,
      });
    });

    it("does not re-warn about the same stale token within the re-alert interval", async () => {
      process.env.PROVIDER_TOKEN_ALERT_WEBHOOK_URL =
        "https://webhook.example.com/token-alert";

      accountingServiceMock.getAllActiveConnections.mockResolvedValue([
        connection({ updatedAt: new Date(now - 50 * DAY_MS) }),
      ]);

      await runProviderTokenWatchdogJob();
      await runProviderTokenWatchdogJob();

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("skips the stale-token warning when no webhook is configured", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      accountingServiceMock.getAllActiveConnections.mockResolvedValue([
        connection({ updatedAt: new Date(now - 50 * DAY_MS) }),
      ]);

      await runProviderTokenWatchdogJob();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no alert webhook URL is configured"),
      );

      warnSpy.mockRestore();
    });
  });
});
