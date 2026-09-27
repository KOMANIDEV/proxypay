import * as StellarSdk from "stellar-sdk";
import { getStellarServer } from "../config/stellar";
import { notifySlackAlert } from "../services/loggers";
import {
  hasTrustline,
  createTrustline,
  createSponsoredTrustline,
} from "../stellar/trustlines";
import {
  trustlineChecksTotal,
  trustlineRestorationsTotal,
  trustlineAlertsTotal,
} from "../utils/metrics";

/**
 * Trustline Monitor Job
 * Schedule: Every 10 minutes (configurable via TRUSTLINE_MONITOR_CRON)
 *
 * Periodically verifies that hot wallet accounts have required asset trustlines.
 * - Alerts when trustlines are missing
 * - Attempts automatic restoration if STELLAR_ISSUER_SECRET is configured
 * - Tracks metrics for trustline health
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrustlineConfig {
  assetCode: string;
  assetIssuer: string;
}

export interface WalletTrustlineStatus {
  publicKey: string;
  asset: StellarSdk.Asset;
  hasTrustline: boolean;
}

export interface TrustlineMonitorResult {
  walletCount: number;
  totalChecks: number;
  healthy: number;
  missing: number;
  restored: number;
  failed: number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

function getHotWalletPublicKeys(): string[] {
  const keys = process.env.HOT_WALLET_PUBLIC_KEYS;
  if (!keys) {
    console.warn("[trustline-monitor] HOT_WALLET_PUBLIC_KEYS not configured");
    return [];
  }
  return keys
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

function getRequiredAssets(): TrustlineConfig[] {
  const assets: TrustlineConfig[] = [];

  // Parse TRUSTLINE_MONITOR_ASSETS env var (e.g. "USDC:ISSUER1,XAF:ISSUER2")
  const assetsEnv = process.env.TRUSTLINE_MONITOR_ASSETS;
  if (assetsEnv) {
    const entries = assetsEnv.split(",");
    for (const entry of entries) {
      const [code, issuer] = entry.trim().split(":");
      if (code && issuer) {
        assets.push({ assetCode: code.trim(), assetIssuer: issuer.trim() });
      }
    }
  }

  return assets;
}

function shouldAutoRestore(): boolean {
  return process.env.TRUSTLINE_AUTO_RESTORE === "true";
}

function getSponsorKeypair(): StellarSdk.Keypair | null {
  const sponsorSecret = process.env.TRUSTLINE_SPONSOR_SECRET;
  if (!sponsorSecret) return null;
  try {
    return StellarSdk.Keypair.fromSecret(sponsorSecret);
  } catch {
    console.warn("[trustline-monitor] Invalid TRUSTLINE_SPONSOR_SECRET");
    return null;
  }
}

function getIssuerKeypair(): StellarSdk.Keypair | null {
  const issuerSecret = process.env.STELLAR_ISSUER_SECRET;
  if (!issuerSecret) return null;
  try {
    return StellarSdk.Keypair.fromSecret(issuerSecret);
  } catch {
    console.warn("[trustline-monitor] Invalid STELLAR_ISSUER_SECRET");
    return null;
  }
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function checkWalletTrustlines(
  publicKey: string,
  requiredAssets: TrustlineConfig[],
): Promise<WalletTrustlineStatus[]> {
  const server = getStellarServer();
  const statuses: WalletTrustlineStatus[] = [];

  try {
    const account = await server.loadAccount(publicKey);

    for (const assetConfig of requiredAssets) {
      const asset = new StellarSdk.Asset(
        assetConfig.assetCode,
        assetConfig.assetIssuer,
      );

      const hasExistingTrustline = account.balances.some((b) => {
        if (b.asset_type === "native" || b.asset_type === "liquidity_pool_shares") {
          return false;
        }
        const balance = b as
          | StellarSdk.Horizon.HorizonApi.BalanceLine<"credit_alphanum4">
          | StellarSdk.Horizon.HorizonApi.BalanceLine<"credit_alphanum12">;
        return (
          balance.asset_code === assetConfig.assetCode &&
          balance.asset_issuer === assetConfig.assetIssuer
        );
      });

      statuses.push({
        publicKey,
        asset,
        hasTrustline: hasExistingTrustline,
      });
    }
  } catch (err: unknown) {
    console.error(
      `[trustline-monitor] Failed to load account ${publicKey}:`,
      err,
    );
  }

  return statuses;
}

async function restoreTrustline(
  publicKey: string,
  asset: StellarSdk.Asset,
  sponsorKeypair: StellarSdk.Keypair | null,
): Promise<boolean> {
  const issuerKeypair = getIssuerKeypair();
  if (!issuerKeypair) {
    console.warn(
      `[trustline-monitor] Cannot restore trustline: STELLAR_ISSUER_SECRET not configured`,
    );
    return false;
  }

  try {
    if (sponsorKeypair) {
      await createSponsoredTrustline({
        accountKeypair: issuerKeypair,
        sponsorKeypair,
        asset,
      });
    } else {
      await createTrustline({
        accountKeypair: issuerKeypair,
        asset,
      });
    }

    trustlineRestorationsTotal.inc({
      asset_code: asset.getCode(),
      status: "success",
    });
    return true;
  } catch (err: unknown) {
    console.error(
      `[trustline-monitor] Failed to restore trustline for ${asset.getCode()} on ${publicKey}:`,
      err,
    );
    trustlineRestorationsTotal.inc({
      asset_code: asset.getCode(),
      status: "failed",
    });
    return false;
  }
}

// ── Job entry point ───────────────────────────────────────────────────────────

export async function runTrustlineMonitorJob(): Promise<TrustlineMonitorResult> {
  const wallets = getHotWalletPublicKeys();
  const requiredAssets = getRequiredAssets();
  const autoRestore = shouldAutoRestore();
  const sponsorKeypair = getSponsorKeypair();

  const result: TrustlineMonitorResult = {
    walletCount: wallets.length,
    totalChecks: 0,
    healthy: 0,
    missing: 0,
    restored: 0,
    failed: 0,
  };

  if (wallets.length === 0) {
    console.log("[trustline-monitor] No hot wallets configured");
    return result;
  }

  if (requiredAssets.length === 0) {
    console.log("[trustline-monitor] No required assets configured (TRUSTLINE_MONITOR_ASSETS)");
    return result;
  }

  console.log(
    `[trustline-monitor] Checking ${wallets.length} wallets for ${requiredAssets.length} assets`,
  );

  for (const walletKey of wallets) {
    const statuses = await checkWalletTrustlines(walletKey, requiredAssets);

    for (const status of statuses) {
      result.totalChecks++;

      trustlineChecksTotal.inc({
        asset_code: status.asset.getCode(),
        has_trustline: String(status.hasTrustline),
      });

      if (status.hasTrustline) {
        result.healthy++;
        continue;
      }

      // Trustline is missing
      result.missing++;
      const assetCode = status.asset.getCode();

      console.warn(
        `[trustline-monitor] ALERT: Wallet ${walletKey} missing trustline for ${assetCode}`,
      );

      trustlineAlertsTotal.inc({ asset_code: assetCode });

      // Send Slack alert
      await notifySlackAlert(
        {
          statusCode: 500,
          method: "MONITOR",
          path: `/trustline/${walletKey}`,
          timestamp: new Date().toISOString(),
          error: new Error(
            `Missing trustline: Wallet ${walletKey} has no trustline for ${assetCode} (${status.asset.getIssuer()})`,
          ),
        },
        {
          appName: "trustline-monitor",
        },
      );

      // Attempt automatic restoration if enabled
      if (autoRestore) {
        const restored = await restoreTrustline(
          walletKey,
          status.asset,
          sponsorKeypair,
        );
        if (restored) {
          result.restored++;
          console.log(
            `[trustline-monitor] Successfully restored trustline for ${assetCode} on ${walletKey}`,
          );
        } else {
          result.failed++;
        }
      }
    }
  }

  console.log(
    `[trustline-monitor] Complete: ${result.healthy}/${result.totalChecks} healthy, ` +
      `${result.missing} missing, ${result.restored} restored, ${result.failed} failed`,
  );

  return result;
}
