/**
 * Unit tests — ProviderBalanceReserveService
 *
 * Issue #412 — Provider Balance Reserve Monitoring
 */

import {
  ProviderBalanceReserveService,
  runProviderBalanceReserveJob,
  type ProviderBalanceSnapshot,
  type BalanceForecast,
} from "../../../src/services/providerBalanceReserve";
import { getBalanceReserveConfig } from "../../../src/config/balanceReserve";
import { providerBalanceCache } from "../../../src/services/providerBalanceCache";
import * as database from "../../../src/config/database";
import * as loggers from "../../../src/services/loggers";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../../../src/services/loggers", () => ({
  notifySlackAlert: jest.fn().mockResolvedValue(undefined),
}));

// Keep fetch calls from hitting the network
global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeQueryReadMock = (overrides: Record<string, unknown> = {}) => {
  const queryRead = database.queryRead as jest.Mock;
  // balance query
  queryRead.mockResolvedValueOnce({
    rows: [{ available_balance: String(overrides.balance ?? 100_000) }],
  });
  // avg daily outflow query
  queryRead.mockResolvedValueOnce({
    rows: [{ daily_avg: String(overrides.avgOutflow ?? 1_000) }],
  });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProviderBalanceReserveService.runCheck()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Balances are served through a process-wide cache (Issue #634); clear it so
    // each test observes only its own mocked DB responses.
    providerBalanceCache.invalidate();
  });

  it("returns a report with snapshots for every configured provider", async () => {
    const config = getBalanceReserveConfig();
    const providerCount = Object.keys(config.providers).length;

    // Stub DB calls for every provider (2 calls per provider)
    for (let i = 0; i < providerCount; i++) {
      makeQueryReadMock({ balance: 200_000, avgOutflow: 5_000 });
    }

    const report = await ProviderBalanceReserveService.runCheck();

    expect(report.snapshots).toHaveLength(providerCount);
    expect(report.forecasts).toHaveLength(providerCount);
    expect(typeof report.generatedAt).toBe("string");
  });

  it("marks status 'ok' when balance is well above the minimum reserve", async () => {
    const config = getBalanceReserveConfig();
    const providerCount = Object.keys(config.providers).length;

    for (let i = 0; i < providerCount; i++) {
      // balance = 2× minimum reserve → well above 80% alert threshold
      makeQueryReadMock({ balance: config.providers.mtn.minimumReserve * 2 });
    }

    const report = await ProviderBalanceReserveService.runCheck();
    const okSnapshots = report.snapshots.filter((s) => s.status === "ok");
    expect(okSnapshots.length).toBeGreaterThan(0);
  });

  it("marks status 'approaching' when balance is between alert threshold and minimum", async () => {
    const config = getBalanceReserveConfig();
    const { minimumReserve, alertThresholdFraction } =
      config.providers.mtn;
    const alertThreshold = minimumReserve * alertThresholdFraction;
    // Balance between alert threshold and minimum → "approaching" for MTN
    const balance = (alertThreshold + minimumReserve) / 2 + 1;
    const providerCount = Object.keys(config.providers).length;

    for (let i = 0; i < providerCount; i++) {
      makeQueryReadMock({ balance });
    }

    const report = await ProviderBalanceReserveService.runCheck();
    const mtnSnapshot = report.snapshots.find((s) => s.provider === "mtn");
    expect(mtnSnapshot?.status).toBe("approaching");
  });

  it("marks status 'critical' when balance is below the minimum reserve", async () => {
    const config = getBalanceReserveConfig();
    const { minimumReserve } = config.providers.mtn;
    const providerCount = Object.keys(config.providers).length;

    for (let i = 0; i < providerCount; i++) {
      makeQueryReadMock({ balance: minimumReserve - 1 });
    }

    const report = await ProviderBalanceReserveService.runCheck();
    const criticalSnapshots = report.snapshots.filter(
      (s) => s.status === "critical",
    );
    expect(criticalSnapshots.length).toBeGreaterThan(0);
  });

  it("fires a Slack alert when a provider balance is not 'ok'", async () => {
    const config = getBalanceReserveConfig();
    const { minimumReserve } = config.providers.mtn;
    const providerCount = Object.keys(config.providers).length;

    for (let i = 0; i < providerCount; i++) {
      makeQueryReadMock({ balance: minimumReserve - 1 });
    }

    await ProviderBalanceReserveService.runCheck();

    expect(loggers.notifySlackAlert).toHaveBeenCalled();
  });

  it("does not fire an alert when all balances are healthy", async () => {
    const config = getBalanceReserveConfig();
    const providerCount = Object.keys(config.providers).length;

    for (let i = 0; i < providerCount; i++) {
      makeQueryReadMock({ balance: config.providers.mtn.minimumReserve * 3 });
    }

    const report = await ProviderBalanceReserveService.runCheck();
    expect(report.alertsFired).toHaveLength(0);
    expect(loggers.notifySlackAlert).not.toHaveBeenCalled();
  });

  it("includes forecasted balance and avg daily outflow in report", async () => {
    const config = getBalanceReserveConfig();
    const providerCount = Object.keys(config.providers).length;
    const avgOutflow = 2_000;

    for (let i = 0; i < providerCount; i++) {
      makeQueryReadMock({ balance: 200_000, avgOutflow });
    }

    const report = await ProviderBalanceReserveService.runCheck();
    const forecast = report.forecasts[0];
    expect(forecast.averageDailyOutflow).toBe(avgOutflow);
    expect(forecast.forecastedBalanceIn7Days).toBeCloseTo(
      200_000 - avgOutflow * 7,
    );
  });

  it("handles DB errors gracefully and still returns a report", async () => {
    const queryRead = database.queryRead as jest.Mock;
    queryRead.mockRejectedValue(new Error("DB connection lost"));

    const report = await ProviderBalanceReserveService.runCheck();
    // Should still return a report (with zero balances)
    expect(report.snapshots).toBeDefined();
  });
});

describe("runProviderBalanceReserveJob()", () => {
  it("is a callable async function that delegates to ProviderBalanceReserveService", async () => {
    const runCheckSpy = jest
      .spyOn(ProviderBalanceReserveService, "runCheck")
      .mockResolvedValue({
        generatedAt: new Date().toISOString(),
        snapshots: [],
        forecasts: [],
        alertsFired: [],
      });

    await runProviderBalanceReserveJob();
    expect(runCheckSpy).toHaveBeenCalledTimes(1);
  });
});

describe("ProviderBalanceReserveService start/stop", () => {
  afterEach(() => {
    ProviderBalanceReserveService.stop();
  });

  it("starts and stops the polling interval without throwing", () => {
    expect(() => {
      ProviderBalanceReserveService.start(60_000);
      ProviderBalanceReserveService.stop();
    }).not.toThrow();
  });

  it("is idempotent — calling start twice only creates one interval", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    ProviderBalanceReserveService.start(60_000);
    ProviderBalanceReserveService.start(60_000); // second call — no-op
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });
});
