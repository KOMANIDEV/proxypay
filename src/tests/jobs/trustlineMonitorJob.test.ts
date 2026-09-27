import * as StellarSdk from "stellar-sdk";
import { runTrustlineMonitorJob } from "../../jobs/trustlineMonitorJob";

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn().mockReturnValue("Test SDF Network ; September 2015"),
}));

jest.mock("../../services/loggers", () => ({
  notifySlackAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../stellar/trustlines", () => ({
  hasTrustline: jest.fn(),
  createTrustline: jest.fn().mockResolvedValue({ hash: "abc", ledger: 42 }),
  createSponsoredTrustline: jest.fn().mockResolvedValue({ hash: "abc", ledger: 42 }),
}));

jest.mock("../../utils/metrics", () => ({
  trustlineChecksTotal: { inc: jest.fn() },
  trustlineRestorationsTotal: { inc: jest.fn() },
  trustlineAlertsTotal: { inc: jest.fn() },
}));

import { getStellarServer } from "../../config/stellar";
import { notifySlackAlert } from "../../services/loggers";
import {
  trustlineChecksTotal,
  trustlineRestorationsTotal,
  trustlineAlertsTotal,
} from "../../utils/metrics";

const mockLoadAccount = jest.fn();
const mockServer = { loadAccount: mockLoadAccount };

const ISSUER = StellarSdk.Keypair.random().publicKey();
const USDC = new StellarSdk.Asset("USDC", ISSUER);

function makeAccount(trustedAssets: StellarSdk.Asset[] = []) {
  const balances: any[] = [
    { asset_type: "native", balance: "10.0000000" },
    ...trustedAssets.map((asset) => ({
      asset_type: asset.getCode().length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
      asset_code: asset.getCode(),
      asset_issuer: asset.getIssuer(),
      balance: "0.0000000",
      limit: "922337203685.4775807",
    })),
  ];

  return {
    id: "GABC123",
    account_id: "GABC123",
    balances,
    sequence: "1",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getStellarServer as jest.Mock).mockReturnValue(mockServer);
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("runTrustlineMonitorJob", () => {
  it("returns early when no hot wallets configured", async () => {
    delete process.env.HOT_WALLET_PUBLIC_KEYS;
    delete process.env.TRUSTLINE_MONITOR_ASSETS;

    const result = await runTrustlineMonitorJob();
    expect(result.walletCount).toBe(0);
    expect(result.totalChecks).toBe(0);
  });

  it("returns early when no required assets configured", async () => {
    process.env.HOT_WALLET_PUBLIC_KEYS = "GABC123";
    delete process.env.TRUSTLINE_MONITOR_ASSETS;

    const result = await runTrustlineMonitorJob();
    expect(result.totalChecks).toBe(0);
  });

  it("reports healthy when all trustlines present", async () => {
    process.env.HOT_WALLET_PUBLIC_KEYS = "GABC123";
    process.env.TRUSTLINE_MONITOR_ASSETS = `USDC:${ISSUER}`;

    mockLoadAccount.mockResolvedValue(makeAccount([USDC]));

    const result = await runTrustlineMonitorJob();
    expect(result.healthy).toBe(1);
    expect(result.missing).toBe(0);
    expect(trustlineChecksTotal.inc).toHaveBeenCalledWith({
      asset_code: "USDC",
      has_trustline: "true",
    });
  });

  it("detects missing trustlines and sends alerts", async () => {
    process.env.HOT_WALLET_PUBLIC_KEYS = "GABC123";
    process.env.TRUSTLINE_MONITOR_ASSETS = `USDC:${ISSUER}`;

    mockLoadAccount.mockResolvedValue(makeAccount([]));

    const result = await runTrustlineMonitorJob();
    expect(result.missing).toBe(1);
    expect(notifySlackAlert).toHaveBeenCalled();
    expect(trustlineAlertsTotal.inc).toHaveBeenCalledWith({ asset_code: "USDC" });
  });

  it("attempts auto-restoration when TRUSTLINE_AUTO_RESTORE=true", async () => {
    process.env.HOT_WALLET_PUBLIC_KEYS = "GABC123";
    process.env.TRUSTLINE_MONITOR_ASSETS = `USDC:${ISSUER}`;
    process.env.TRUSTLINE_AUTO_RESTORE = "true";
    process.env.STELLAR_ISSUER_SECRET = StellarSdk.Keypair.random().secret();

    mockLoadAccount.mockResolvedValue(makeAccount([]));

    const result = await runTrustlineMonitorJob();
    expect(result.restored).toBe(1);
    expect(trustlineRestorationsTotal.inc).toHaveBeenCalledWith({
      asset_code: "USDC",
      status: "success",
    });

    delete process.env.TRUSTLINE_AUTO_RESTORE;
    delete process.env.STELLAR_ISSUER_SECRET;
  });

  it("handles multiple wallets", async () => {
    process.env.HOT_WALLET_PUBLIC_KEYS = "GABC123,GDEF456";
    process.env.TRUSTLINE_MONITOR_ASSETS = `USDC:${ISSUER}`;

    mockLoadAccount
      .mockResolvedValueOnce(makeAccount([USDC]))
      .mockResolvedValueOnce(makeAccount([]));

    const result = await runTrustlineMonitorJob();
    expect(result.walletCount).toBe(2);
    expect(result.healthy).toBe(1);
    expect(result.missing).toBe(1);
  });

  it("handles Horizon errors gracefully", async () => {
    process.env.HOT_WALLET_PUBLIC_KEYS = "GABC123";
    process.env.TRUSTLINE_MONITOR_ASSETS = `USDC:${ISSUER}`;

    mockLoadAccount.mockRejectedValue(new Error("Horizon unavailable"));

    const result = await runTrustlineMonitorJob();
    expect(result.totalChecks).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });
});
