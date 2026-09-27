/**
 * Provider Balance Reserve Monitoring Service
 *
 * Monitors mobile money provider balances against configurable minimum reserve
 * thresholds. Sends alerts when balances approach (80 % threshold) or fall
 * below the minimum reserve, and forecasts future balance levels based on the
 * last 7 days of transaction history.
 *
 * Issue #412 — Provider Balance Reserve Monitoring
 */

import { queryRead } from "../config/database";
import {
  getBalanceReserveConfig,
  type ProviderName,
  type ProviderReserveConfig,
} from "../config/balanceReserve";
import { notifySlackAlert } from "./loggers";
import { providerBalanceCache } from "./providerBalanceCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderBalanceSnapshot {
  provider: ProviderName;
  currentBalance: number;
  currency: string;
  minimumReserve: number;
  alertThreshold: number;
  status: "ok" | "approaching" | "critical";
  percentageOfReserve: number;
  /** Epoch ms at which the balance value was fetched (Issue #634). */
  balanceFetchedAt?: number;
  /** Age of the balance value in ms at report time (Issue #634). */
  balanceAgeMs?: number;
  /** True when the balance was served from a stale cache entry (Issue #634). */
  balanceStale?: boolean;
  /** Warning message when stale balance data was used (Issue #634). */
  balanceWarning?: string;
}

export interface BalanceForecast {
  provider: ProviderName;
  averageDailyOutflow: number;
  estimatedDaysUntilMinimum: number | null;
  forecastedBalanceIn7Days: number;
  currency: string;
}

export interface ProviderBalanceReserveReport {
  generatedAt: string;
  snapshots: ProviderBalanceSnapshot[];
  forecasts: BalanceForecast[];
  alertsFired: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetches the current operational balance for a provider from the database.
 * Looks at the most recent settled transaction batching rows in the
 * provider_balances table (created by the existing balance worker).
 * Falls back to 0 if no record exists yet.
 */
async function fetchCurrentBalanceFromDb(
  provider: ProviderName,
): Promise<number> {
  const result = await queryRead<{ available_balance: string }>(
    `SELECT available_balance
       FROM provider_balances
      WHERE provider = $1
      ORDER BY recorded_at DESC
      LIMIT 1`,
    [provider],
  );
  if (result.rows.length === 0) return 0;
  return parseFloat(result.rows[0].available_balance) || 0;
}

/**
 * Calculates the average daily outflow for the last N days from the
 * transactions table.  Only completed withdraw/payout transactions are
 * considered as they represent real cash leaving the float.
 */
async function fetchAverageDailyOutflow(
  provider: ProviderName,
  windowDays: number,
): Promise<number> {
  const result = await queryRead<{ daily_avg: string }>(
    `SELECT COALESCE(SUM(amount::numeric) / NULLIF($2::numeric, 0), 0) AS daily_avg
       FROM transactions
      WHERE provider  = $1
        AND type      IN ('withdraw', 'payout')
        AND status    = 'completed'
        AND created_at >= NOW() - ($2 || ' days')::interval`,
    [provider, windowDays],
  );
  return parseFloat(result.rows[0]?.daily_avg ?? "0") || 0;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function buildSnapshot(
  provider: ProviderName,
  currentBalance: number,
  cfg: ProviderReserveConfig,
  balanceMeta?: {
    fetchedAt: number;
    ageMs: number;
    stale: boolean;
    warning?: string;
  },
): ProviderBalanceSnapshot {
  const alertThreshold = cfg.minimumReserve * cfg.alertThresholdFraction;
  const percentageOfReserve =
    cfg.minimumReserve > 0
      ? Math.round((currentBalance / cfg.minimumReserve) * 100)
      : 100;

  let status: ProviderBalanceSnapshot["status"] = "ok";
  if (currentBalance < cfg.minimumReserve) {
    status = "critical";
  } else if (currentBalance < alertThreshold) {
    status = "approaching";
  }

  return {
    provider,
    currentBalance,
    currency: cfg.currency,
    minimumReserve: cfg.minimumReserve,
    alertThreshold,
    status,
    percentageOfReserve,
    ...(balanceMeta
      ? {
          balanceFetchedAt: balanceMeta.fetchedAt,
          balanceAgeMs: balanceMeta.ageMs,
          balanceStale: balanceMeta.stale,
          balanceWarning: balanceMeta.warning,
        }
      : {}),
  };
}

function buildForecast(
  provider: ProviderName,
  currentBalance: number,
  averageDailyOutflow: number,
  cfg: ProviderReserveConfig,
): BalanceForecast {
  const forecastedBalanceIn7Days = Math.max(
    0,
    currentBalance - averageDailyOutflow * 7,
  );

  let estimatedDaysUntilMinimum: number | null = null;
  if (averageDailyOutflow > 0) {
    const daysUntil =
      (currentBalance - cfg.minimumReserve) / averageDailyOutflow;
    estimatedDaysUntilMinimum = daysUntil > 0 ? Math.floor(daysUntil) : 0;
  }

  return {
    provider,
    averageDailyOutflow,
    estimatedDaysUntilMinimum,
    forecastedBalanceIn7Days,
    currency: cfg.currency,
  };
}

async function sendLowBalanceNotification(
  snapshot: ProviderBalanceSnapshot,
  forecast: BalanceForecast,
  opsWebhookUrl: string,
): Promise<void> {
  const forecastNote =
    forecast.estimatedDaysUntilMinimum !== null
      ? ` — estimated ${forecast.estimatedDaysUntilMinimum} day(s) until minimum reserve reached`
      : "";

  const message = [
    `Provider ${snapshot.provider.toUpperCase()} balance reserve alert [${snapshot.status.toUpperCase()}]`,
    `Current balance: ${snapshot.currentBalance.toLocaleString()} ${snapshot.currency}`,
    `Minimum reserve: ${snapshot.minimumReserve.toLocaleString()} ${snapshot.currency}`,
    `(${snapshot.percentageOfReserve}% of reserve)${forecastNote}`,
  ].join(" | ");

  // Slack-compatible alert reusing the existing loggers utility
  await notifySlackAlert(
    {
      statusCode: snapshot.status === "critical" ? 500 : 429,
      method: "MONITOR",
      path: `/provider-balance/${snapshot.provider}`,
      timestamp: new Date().toISOString(),
      error: new Error(message),
    },
    { appName: "provider-balance-reserve" },
  );

  // Optional: post to ops notification webhook if separately configured
  if (opsWebhookUrl && opsWebhookUrl !== process.env.SLACK_ALERTS_WEBHOOK_URL) {
    try {
      await fetch(opsWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alertType: "provider_balance_reserve",
          severity: snapshot.status === "critical" ? "critical" : "warning",
          provider: snapshot.provider,
          message,
          snapshot,
          forecast,
          generatedAt: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.warn(
        `[provider-balance-reserve] Ops webhook failed: ${toErrorMessage(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class ProviderBalanceReserveService {
  private static checkInterval: NodeJS.Timeout | null = null;

  /**
   * Run a single check cycle: fetch balances, compute snapshots + forecasts,
   * fire alerts where needed, return the full report.
   */
  static async runCheck(): Promise<ProviderBalanceReserveReport> {
    const config = getBalanceReserveConfig();
    const providers = Object.keys(config.providers) as ProviderName[];
    const alertsFired: string[] = [];

    const [snapshots, forecasts] = await (async () => {
      const snaps: ProviderBalanceSnapshot[] = [];
      const fcsts: BalanceForecast[] = [];

      for (const provider of providers) {
        const cfg = config.providers[provider];
        let currentBalance = 0;
        let avgOutflow = 0;
        let balanceMeta:
          | {
              fetchedAt: number;
              ageMs: number;
              stale: boolean;
              warning?: string;
            }
          | undefined;

        try {
          // Balances are served through the age-aware cache so stale data is
          // detected, reported and refreshed automatically (Issue #634).
          const cached = await providerBalanceCache.get(provider, async () => ({
            availableBalance: await fetchCurrentBalanceFromDb(provider),
            currency: cfg.currency,
          }));

          currentBalance = cached.availableBalance;
          balanceMeta = {
            fetchedAt: cached.fetchedAt,
            ageMs: cached.ageMs,
            stale: cached.stale,
            warning: cached.warning,
          };

          if (cached.stale) {
            console.warn(
              `[provider-balance-reserve] ${provider} balance cache is stale ` +
                `(${cached.ageMs}ms old)${cached.warning ? ` — ${cached.warning}` : ""}`,
            );
          }
        } catch (err) {
          console.error(
            `[provider-balance-reserve] Could not fetch balance for ${provider}: ${toErrorMessage(err)}`,
          );
        }

        try {
          avgOutflow = await fetchAverageDailyOutflow(
            provider,
            cfg.forecastWindowDays,
          );
        } catch (err) {
          console.warn(
            `[provider-balance-reserve] Could not compute outflow for ${provider}: ${toErrorMessage(err)}`,
          );
        }

        const snapshot = buildSnapshot(provider, currentBalance, cfg, balanceMeta);
        const forecast = buildForecast(provider, currentBalance, avgOutflow, cfg);

        snaps.push(snapshot);
        fcsts.push(forecast);

        if (snapshot.status !== "ok") {
          alertsFired.push(
            `${provider}: balance ${currentBalance} (${snapshot.status})`,
          );
          try {
            await sendLowBalanceNotification(
              snapshot,
              forecast,
              config.opsNotificationWebhookUrl,
            );
          } catch (err) {
            console.error(
              `[provider-balance-reserve] Failed to send notification for ${provider}: ${toErrorMessage(err)}`,
            );
          }
        } else {
          console.log(
            `[provider-balance-reserve] ${provider.toUpperCase()} OK — ` +
              `${currentBalance.toLocaleString()} ${cfg.currency} ` +
              `(${snapshot.percentageOfReserve}% of reserve)`,
          );
        }
      }

      return [snaps, fcsts];
    })();

    return {
      generatedAt: new Date().toISOString(),
      snapshots,
      forecasts,
      alertsFired,
    };
  }

  /**
   * Start a periodic polling loop.
   * Idempotent — subsequent calls are no-ops.
   */
  static start(intervalMs = 10 * 60 * 1000): void {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(async () => {
      try {
        await ProviderBalanceReserveService.runCheck();
      } catch (err) {
        console.error(
          `[provider-balance-reserve] Unexpected error during check: ${toErrorMessage(err)}`,
        );
      }
    }, intervalMs);
    console.log(
      `[provider-balance-reserve] Monitoring started (interval: ${intervalMs}ms)`,
    );
  }

  /** Stop the polling loop. */
  static stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

/**
 * Job-style entry point so this can be wired into the existing scheduler.
 */
export async function runProviderBalanceReserveJob(): Promise<void> {
  await ProviderBalanceReserveService.runCheck();
}

export const providerBalanceReserveService = ProviderBalanceReserveService;
