/**
 * Balance Reserve Configuration
 *
 * Defines minimum balance reserve thresholds and alert parameters for each
 * mobile money provider. Values are read from environment variables so they
 * can be tuned per deployment without a code change.
 *
 * Issue #412 — Provider Balance Reserve Monitoring
 */

export type ProviderName = "mtn" | "airtel" | "orange";

export interface ProviderReserveConfig {
  /** Minimum balance that must always be held (in provider currency units). */
  minimumReserve: number;
  /** Currency code for this provider's balance (e.g. "XAF"). */
  currency: string;
  /**
   * Fraction of minimumReserve at which an "approaching minimum" alert fires.
   * Default: 0.80 — alert when balance falls below 80 % of minimum reserve.
   */
  alertThresholdFraction: number;
  /**
   * Number of days of transaction history to use when forecasting future balance.
   * Default: 7 (last 7 days).
   */
  forecastWindowDays: number;
}

export interface BalanceReserveConfig {
  providers: Record<ProviderName, ProviderReserveConfig>;
  /** Operations team email/webhook to notify on low-balance events. */
  opsNotificationEmail: string;
  opsNotificationWebhookUrl: string;
}

function parseFloat_(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseInt_(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getBalanceReserveConfig(): BalanceReserveConfig {
  return {
    providers: {
      mtn: {
        minimumReserve: parseFloat_(
          process.env.MTN_MINIMUM_RESERVE,
          50_000,
        ),
        currency: process.env.MTN_BALANCE_CURRENCY ?? "XAF",
        alertThresholdFraction: parseFloat_(
          process.env.MTN_RESERVE_ALERT_THRESHOLD_FRACTION,
          0.8,
        ),
        forecastWindowDays: parseInt_(
          process.env.MTN_RESERVE_FORECAST_WINDOW_DAYS,
          7,
        ),
      },
      airtel: {
        minimumReserve: parseFloat_(
          process.env.AIRTEL_MINIMUM_RESERVE,
          50_000,
        ),
        currency: process.env.AIRTEL_BALANCE_CURRENCY ?? "XAF",
        alertThresholdFraction: parseFloat_(
          process.env.AIRTEL_RESERVE_ALERT_THRESHOLD_FRACTION,
          0.8,
        ),
        forecastWindowDays: parseInt_(
          process.env.AIRTEL_RESERVE_FORECAST_WINDOW_DAYS,
          7,
        ),
      },
      orange: {
        minimumReserve: parseFloat_(
          process.env.ORANGE_MINIMUM_RESERVE,
          50_000,
        ),
        currency: process.env.ORANGE_BALANCE_CURRENCY ?? "XAF",
        alertThresholdFraction: parseFloat_(
          process.env.ORANGE_RESERVE_ALERT_THRESHOLD_FRACTION,
          0.8,
        ),
        forecastWindowDays: parseInt_(
          process.env.ORANGE_RESERVE_FORECAST_WINDOW_DAYS,
          7,
        ),
      },
    },
    opsNotificationEmail:
      process.env.OPS_NOTIFICATION_EMAIL ?? "",
    opsNotificationWebhookUrl:
      process.env.OPS_NOTIFICATION_WEBHOOK_URL ??
      process.env.SLACK_ALERTS_WEBHOOK_URL ??
      "",
  };
}
