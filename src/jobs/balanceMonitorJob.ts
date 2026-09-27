import * as StellarSdk from "stellar-sdk";
import { getStellarServer } from "../config/stellar";
import { notifySlackAlert } from "../services/loggers";
import { calculateStellarReserve, formatReserveInfo } from "../utils/stellarReserveCalculator";
import { redisClient } from "../config/redis";

/**
 * Balance Monitor Job
 * Schedule: Every 5 minutes (configurable via BALANCE_MONITOR_CRON)
 * Monitors Stellar hot wallet balances and alerts if below thresholds.
 * Also warns admins if XLM reserve falls below threshold.
 */

export interface BalanceThreshold {
  asset: string; // "XLM" or asset code like "USDC"
  threshold: number;
}

export interface WalletBalance {
  publicKey: string;
  balances: Array<{
    asset: string;
    balance: number;
  }>;
}

export const BALANCE_MONITOR_LOCK_KEY = "lock:job:balance-monitor";
export const BALANCE_MONITOR_LOCK_TTL = parseInt(
  process.env.BALANCE_MONITOR_LOCK_TTL || "240",
  10
);
export const BALANCE_BROADCAST_CHANNEL = "balance:monitor:broadcast";
export const BALANCE_CACHE_TTL_SECONDS = 300;

export async function acquireBalanceMonitorLock(): Promise<boolean> {
  if (!redisClient?.isOpen) {
    return true; // Single-instance fallback when Redis is not running
  }
  try {
    const res = await redisClient.set(
      BALANCE_MONITOR_LOCK_KEY,
      process.env.HOSTNAME || "instance",
      {
        NX: true,
        EX: BALANCE_MONITOR_LOCK_TTL,
      }
    );
    return res !== null;
  } catch (err) {
    console.warn("[balance-monitor] Redis lock check failed:", err);
    return true;
  }
}

export async function releaseBalanceMonitorLock(): Promise<void> {
  if (!redisClient?.isOpen) {
    return;
  }
  try {
    await redisClient.del(BALANCE_MONITOR_LOCK_KEY);
  } catch (err) {
    console.warn("[balance-monitor] Redis lock release failed:", err);
  }
}

export async function broadcastWalletBalance(
  walletKey: string,
  balance: WalletBalance
): Promise<void> {
  if (!redisClient?.isOpen) return;
  try {
    await redisClient.setEx(
      `balance:wallet:${walletKey}`,
      BALANCE_CACHE_TTL_SECONDS,
      JSON.stringify(balance)
    );
    await redisClient.publish(
      BALANCE_BROADCAST_CHANNEL,
      JSON.stringify({
        type: "BALANCE_UPDATED",
        walletKey,
        balances: balance,
        timestamp: new Date().toISOString(),
      })
    );
  } catch (err) {
    console.warn("[balance-monitor] Failed to broadcast wallet balance:", err);
  }
}

export async function getCachedWalletBalance(
  publicKey: string
): Promise<WalletBalance | null> {
  if (!redisClient?.isOpen) return null;
  try {
    const raw = await redisClient.get(`balance:wallet:${publicKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn("[balance-monitor] Failed to get cached wallet balance:", err);
    return null;
  }
}


function getHotWalletPublicKeys(): string[] {
  const keys = process.env.HOT_WALLET_PUBLIC_KEYS;
  if (!keys) {
    console.warn("[balance-monitor] HOT_WALLET_PUBLIC_KEYS not configured");
    return [];
  }
  return keys.split(",").map(key => key.trim()).filter(key => key.length > 0);
}

function getBalanceThresholds(): BalanceThreshold[] {
  const thresholds: BalanceThreshold[] = [];

  // Check for XLM threshold
  const xlmThreshold = process.env.BALANCE_THRESHOLD_XLM;
  if (xlmThreshold) {
    thresholds.push({
      asset: "XLM",
      threshold: parseFloat(xlmThreshold),
    });
  }

  // Check for other asset thresholds (e.g. BALANCE_THRESHOLD_USDC=1000)
  Object.keys(process.env).forEach(key => {
    if (key.startsWith("BALANCE_THRESHOLD_") && key !== "BALANCE_THRESHOLD_XLM") {
      const asset = key.replace("BALANCE_THRESHOLD_", "");
      const threshold = parseFloat(process.env[key]!);
      if (!isNaN(threshold)) {
        thresholds.push({ asset, threshold });
      }
    }
  });

  return thresholds;
}

function getStellarMinimumBalanceThreshold(): number {
  // Min XLM above reserve; prevent out of gas
  const threshold = process.env.STELLAR_MIN_BALANCE_ABOVE_RESERVE;
  const defaultValue = 5; // 5 XLM default
  if (!threshold) return defaultValue;
  const parsed = parseFloat(threshold);
  return isNaN(parsed) ? defaultValue : parsed;
}

async function getWalletBalances(publicKey: string): Promise<WalletBalance> {
  const server = getStellarServer();
  try {
    const account = await server.loadAccount(publicKey);
    const balances = account.balances.map(balance => {
      let asset: string;
      let balanceAmount: number;

      if (balance.asset_type === "native") {
        asset = "XLM";
        balanceAmount = parseFloat(balance.balance);
      } else {
        asset = (balance as any).asset_code;
        balanceAmount = parseFloat(balance.balance);
      }

      return { asset, balance: balanceAmount };
    });

    return { publicKey, balances };
  } catch (error) {
    console.error(`[balance-monitor] Failed to load account ${publicKey}:`, error);
    throw error;
  }
}

async function checkBalancesAndAlert(): Promise<void> {
  const lockAcquired = await acquireBalanceMonitorLock();
  if (!lockAcquired) {
    console.log(
      "[balance-monitor] Another instance is currently checking balances or holds the cluster lock; skipping redundant operation"
    );
    return;
  }

  const wallets = getHotWalletPublicKeys();
  const thresholds = getBalanceThresholds();
  const minBalanceThreshold = getStellarMinimumBalanceThreshold();

  if (wallets.length === 0) {
    console.log("[balance-monitor] No hot wallets configured");
    return;
  }

  if (thresholds.length === 0) {
    console.log("[balance-monitor] No balance thresholds configured; checking reserve-only alerts");
  }

  console.log(`[balance-monitor] Checking ${wallets.length} wallets for ${thresholds.length} thresholds`);

  for (const walletKey of wallets) {
    try {
      const walletBalance = await getWalletBalances(walletKey);
      await broadcastWalletBalance(walletKey, walletBalance);

      for (const threshold of thresholds) {
        const balance = walletBalance.balances.find(b => b.asset === threshold.asset);
        if (!balance) {
          // Wallet doesn't hold this asset, skip
          continue;
        }

        if (balance.balance < threshold.threshold) {
          console.warn(
            `[balance-monitor] ALERT: Wallet ${walletKey} has ${balance.balance} ${threshold.asset}, below threshold ${threshold.threshold}`
          );

          // Send Slack alert
          await notifySlackAlert({
            statusCode: 500, // Use 500 to indicate critical issue
            method: "MONITOR",
            path: `/balance/${walletKey}`,
            timestamp: new Date().toISOString(),
            error: new Error(
              `Low balance alert: ${walletKey} has ${balance.balance} ${threshold.asset} (threshold: ${threshold.threshold})`
            ),
          }, {
            appName: "balance-monitor",
          });
        } else {
          console.log(
            `[balance-monitor] OK: Wallet ${walletKey} has ${balance.balance} ${threshold.asset} (threshold: ${threshold.threshold})`
          );
        }
      }

      // Check minimum reserve balance for Stellar
      const reserveInfo = await calculateStellarReserve(walletKey, minBalanceThreshold);
      if (reserveInfo.isBelowThreshold) {
        console.warn(
          `[balance-monitor] RESERVE WARNING: ${formatReserveInfo(reserveInfo)}`
        );

        // Alert admins
        await notifySlackAlert({
          statusCode: 500,
          method: "MONITOR",
          path: `/reserve/${walletKey}`,
          timestamp: new Date().toISOString(),
          error: new Error(
            `Low XLM reserve alert: ${formatReserveInfo(reserveInfo)}`
          ),
        }, {
          appName: "balance-monitor",
        });
      } else {
        console.log(
          `[balance-monitor] RESERVE OK: ${formatReserveInfo(reserveInfo)}`
        );
      }
    } catch (error) {
      console.error(`[balance-monitor] Error checking wallet ${walletKey}:`, error);
      // Send alert for monitoring failure
      await notifySlackAlert({
        statusCode: 500,
        method: "MONITOR",
        path: `/balance/${walletKey}`,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : new Error(String(error)),
      }, {
        appName: "balance-monitor",
      });
    }
  }
}

export async function runBalanceMonitorJob(): Promise<void> {
  await checkBalancesAndAlert();
}
