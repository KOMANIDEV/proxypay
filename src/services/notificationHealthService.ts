/**
 * #479 – Real-Time Notification System Status
 *
 * The notification router deliberately swallows per-channel errors so one
 * failing provider cannot stop the others. The cost of that resilience is
 * that nobody knows whether notifications are actually being delivered: a
 * misconfigured SMTP relay or an expired push credential looks identical to a
 * healthy system from the outside.
 *
 * This module closes that gap.
 *
 *   1. `recordDelivery()` – called by the router for every channel attempt,
 *      persisting success/failure, latency and the error. Never throws: a
 *      failure to record must not affect delivery.
 *   2. `getChannelHealth()` – per-channel success rate, average latency and
 *      a `healthy | degraded | down` verdict over a rolling window.
 *   3. `getSystemStatus()` – the aggregate status that the status endpoint
 *      returns, with the correct HTTP semantics for load balancers.
 *   4. `getDeliveryAnalytics()` – volume, failure rate and per-category
 *      breakdown over a period.
 *   5. `getFailingChannels()` – the channels that have tripped the failure
 *      threshold, which the alerting job escalates.
 */

import { queryRead, queryWrite } from "../config/database";
import logger from "../utils/logger";
import {
  notificationChannelHealthGauge,
  notificationDeliveriesTotal,
  notificationDeliveryDurationSeconds,
  notificationSystemUp,
} from "../utils/metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationChannelName =
  | "email"
  | "sms"
  | "push"
  | "whatsapp"
  | "pagerduty";

export type DeliveryStatus = "delivered" | "failed" | "skipped";
export type ChannelHealthStatus = "healthy" | "degraded" | "down";

export interface DeliveryRecord {
  notificationKey: string;
  channel: NotificationChannelName;
  status: DeliveryStatus;
  durationMs: number;
  category?: string;
  severity?: string;
  userId?: string | null;
  transactionId?: string | null;
  errorMessage?: string | null;
}

export interface ChannelHealth {
  channel: NotificationChannelName;
  status: ChannelHealthStatus;
  attempts: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  lastError: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

export interface DeliveryAnalytics {
  windowHours: number;
  totalAttempts: number;
  delivered: number;
  failed: number;
  failureRate: number;
  avgDurationMs: number;
  byChannel: Array<{
    channel: NotificationChannelName;
    attempts: number;
    failures: number;
    failureRate: number;
  }>;
  byCategory: Array<{ category: string; attempts: number; failures: number }>;
}

export interface SystemStatus {
  status: "healthy" | "degraded" | "down";
  checkedAt: string;
  windowHours: number;
  channels: ChannelHealth[];
  totalAttempts: number;
  overallSuccessRate: number;
  failingChannels: NotificationChannelName[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULTS = {
  /** Success rate below this marks a channel as degraded. */
  degradedThreshold: Number(
    process.env.NOTIFICATION_HEALTH_DEGRADED_THRESHOLD ?? 0.95,
  ),
  /** Success rate at or below this marks a channel as down. */
  downThreshold: Number(
    process.env.NOTIFICATION_HEALTH_DOWN_THRESHOLD ?? 0.5),
  /** A channel with no attempts in the window is reported as down. */
  minAttempts: Number(process.env.NOTIFICATION_HEALTH_MIN_ATTEMPTS ?? 1),
  /** Default rolling window for health calculations. */
  windowHours: Number(process.env.NOTIFICATION_HEALTH_WINDOW_HOURS ?? 24),
};

export const NOTIFICATION_CHANNELS: NotificationChannelName[] = [
  "email",
  "sms",
  "push",
  "whatsapp",
  "pagerduty",
];

// ---------------------------------------------------------------------------
// Delivery recording
// ---------------------------------------------------------------------------

/**
 * Persist the outcome of a single channel attempt.
 *
 * Best-effort by design: the caller is on the notification hot path and a
 * tracking write must never turn a successful send into a failure.
 */
export async function recordDelivery(record: DeliveryRecord): Promise<void> {
  try {
    await queryWrite(
      `INSERT INTO notification_deliveries
         (notification_key, channel, category, severity, user_id,
          transaction_id, status, duration_ms, error_message, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               CASE WHEN $7 = 'delivered' THEN NOW() ELSE NULL END)`,
      [
        record.notificationKey,
        record.channel,
        record.category ?? null,
        record.severity ?? null,
        record.userId ?? null,
        record.transactionId ?? null,
        record.status,
        record.durationMs,
        record.errorMessage ?? null,
      ],
    );

    notificationDeliveriesTotal
      .labels(record.channel, record.status)
      .inc();
    notificationDeliveryDurationSeconds
      .labels(record.channel, record.status)
      .observe(record.durationMs / 1000);
  } catch (error) {
    logger.warn(
      { error, channel: record.channel, key: record.notificationKey },
      "[notification-health] failed to record delivery",
    );
  }
}

// ---------------------------------------------------------------------------
// Health calculation
// ---------------------------------------------------------------------------

/**
 * Decide a channel's status from its success rate.
 * Exported so the thresholds can be unit tested without a database.
 */
export function classifyChannel(
  successRate: number,
  attempts: number,
  minAttempts = DEFAULTS.minAttempts,
  degradedThreshold = DEFAULTS.degradedThreshold,
  downThreshold = DEFAULTS.downThreshold,
): ChannelHealthStatus {
  // A channel with no traffic is not "healthy" – it is unproven. Reporting it
  // as down is what surfaces a channel that was never wired up.
  if (attempts < minAttempts) return "down";
  if (successRate <= downThreshold) return "down";
  if (successRate < degradedThreshold) return "degraded";
  return "healthy";
}

interface ChannelAggregateRow {
  channel: NotificationChannelName;
  attempts: string;
  success_count: string;
  failure_count: string;
  avg_duration_ms: string | null;
  last_error: string | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
}

/**
 * Per-channel health over the rolling window. Channels with no traffic are
 * still returned so the status endpoint lists every configured channel.
 */
export async function getChannelHealth(
  windowHours: number = DEFAULTS.windowHours,
): Promise<ChannelHealth[]> {
  const { rows } = await queryRead<ChannelAggregateRow>(
    `SELECT channel,
            COUNT(*)::bigint                       AS attempts,
            COUNT(*) FILTER (WHERE status = 'delivered')::bigint AS success_count,
            COUNT(*) FILTER (WHERE status = 'failed')::bigint    AS failure_count,
            COALESCE(AVG(duration_ms), 0)::float    AS avg_duration_ms,
            (ARRAY_AGG(error_message ORDER BY created_at DESC)
              FILTER (WHERE error_message IS NOT NULL))[1] AS last_error,
            MAX(delivered_at)                       AS last_success_at,
            MAX(CASE WHEN status = 'failed' THEN created_at END) AS last_failure_at
       FROM notification_deliveries
      WHERE created_at > NOW() - ($1 || ' hours')::interval
      GROUP BY channel`,
    [String(windowHours)],
  );

  const byChannel = new Map(rows.map((row) => [row.channel, row]));

  return NOTIFICATION_CHANNELS.map((channel) => {
    const row = byChannel.get(channel);
    const attempts = Number(row?.attempts ?? 0);
    const successCount = Number(row?.success_count ?? 0);
    const failureCount = Number(row?.failure_count ?? 0);
    const successRate = attempts > 0 ? successCount / attempts : 0;

    return {
      channel,
      status: classifyChannel(successRate, attempts),
      attempts,
      successCount,
      failureCount,
      successRate: Math.round(successRate * 10_000) / 10_000,
      avgDurationMs: Math.round(Number(row?.avg_duration_ms ?? 0)),
      lastError: row?.last_error ?? null,
      lastSuccessAt: row?.last_success_at ? new Date(row.last_success_at) : null,
      lastFailureAt: row?.last_failure_at ? new Date(row.last_failure_at) : null,
    };
  });
}

/** Channels that have tripped the failure threshold. */
export function getFailingChannels(
  health: ChannelHealth[],
): NotificationChannelName[] {
  return health
    .filter((channel) => channel.status !== "healthy")
    .map((channel) => channel.channel);
}

/**
 * Aggregate status. The overall verdict follows the worst channel: a single
 * `down` channel means notifications are not fully working, so the service
 * must not report itself as healthy.
 */
export async function getSystemStatus(
  windowHours: number = DEFAULTS.windowHours,
): Promise<SystemStatus> {
  const channels = await getChannelHealth(windowHours);

  const totalAttempts = channels.reduce((acc, c) => acc + c.attempts, 0);
  const totalSuccess = channels.reduce((acc, c) => acc + c.successCount, 0);
  const overallSuccessRate =
    totalAttempts > 0 ? totalSuccess / totalAttempts : 0;

  const hasDown = channels.some((c) => c.status === "down");
  const hasDegraded = channels.some((c) => c.status === "degraded");
  const status: SystemStatus["status"] = hasDown
    ? "down"
    : hasDegraded
      ? "degraded"
      : "healthy";

  // Export to Prometheus so alerting can work off standard tooling too.
  notificationSystemUp.set(status === "healthy" ? 1 : 0);
  for (const channel of channels) {
    notificationChannelHealthGauge
      .labels(channel.channel)
      .set(
        channel.status === "healthy" ? 1 : channel.status === "degraded" ? 0.5 : 0,
      );
  }

  return {
    status,
    checkedAt: new Date().toISOString(),
    windowHours,
    channels,
    totalAttempts,
    overallSuccessRate: Math.round(overallSuccessRate * 10_000) / 10_000,
    failingChannels: getFailingChannels(channels),
  };
}

// ---------------------------------------------------------------------------
// Delivery analytics
// ---------------------------------------------------------------------------

/**
 * Volume, failure rate and breakdowns for the delivery analytics view.
 * Three small aggregate queries keep the SQL index-friendly.
 */
export async function getDeliveryAnalytics(
  windowHours: number = DEFAULTS.windowHours,
): Promise<DeliveryAnalytics> {
  const params = [String(windowHours)];

  const { rows: overallRows } = await queryRead<{
    total_attempts: string;
    delivered: string;
    failed: string;
    avg_duration_ms: string | null;
  }>(
    `SELECT COUNT(*)::bigint AS total_attempts,
            COUNT(*) FILTER (WHERE status = 'delivered')::bigint AS delivered,
            COUNT(*) FILTER (WHERE status = 'failed')::bigint    AS failed,
            COALESCE(AVG(duration_ms), 0)::float AS avg_duration_ms
       FROM notification_deliveries
      WHERE created_at > NOW() - ($1 || ' hours')::interval`,
    params,
  );

  const { rows: channelRows } = await queryRead<{
    channel: NotificationChannelName;
    attempts: string;
    failures: string;
  }>(
    `SELECT channel,
            COUNT(*)::bigint AS attempts,
            COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failures
       FROM notification_deliveries
      WHERE created_at > NOW() - ($1 || ' hours')::interval
      GROUP BY channel
      ORDER BY attempts DESC`,
    params,
  );

  const { rows: categoryRows } = await queryRead<{
    category: string;
    attempts: string;
    failures: string;
  }>(
    `SELECT COALESCE(category, 'uncategorised') AS category,
            COUNT(*)::bigint AS attempts,
            COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failures
       FROM notification_deliveries
      WHERE created_at > NOW() - ($1 || ' hours')::interval
      GROUP BY category
      ORDER BY attempts DESC
      LIMIT 20`,
    params,
  );

  const overall = overallRows[0] ?? {};
  const totalAttempts = Number(overall.total_attempts ?? 0);
  const failed = Number(overall.failed ?? 0);

  return {
    windowHours,
    totalAttempts,
    delivered: Number(overall.delivered ?? 0),
    failed,
    failureRate: totalAttempts > 0 ? failed / totalAttempts : 0,
    avgDurationMs: Math.round(Number(overall.avg_duration_ms ?? 0)),
    byChannel: channelRows.map((row) => ({
      channel: row.channel,
      attempts: Number(row.attempts),
      failures: Number(row.failures),
      failureRate:
        Number(row.attempts) > 0
          ? Number(row.failures) / Number(row.attempts)
          : 0,
    })),
    byCategory: categoryRows.map((row) => ({
      category: row.category,
      attempts: Number(row.attempts),
      failures: Number(row.failures),
    })),
  };
}

/**
 * Persist the current health snapshot so the status endpoint can be served
 * from cache and so the alerting job can detect transitions.
 */
export async function snapshotChannelHealth(
  windowHours: number = DEFAULTS.windowHours,
): Promise<ChannelHealth[]> {
  const health = await getChannelHealth(windowHours);

  for (const channel of health) {
    try {
      await queryWrite(
        `INSERT INTO notification_channel_health
           (channel, status, success_count, failure_count, avg_duration_ms,
            last_error, last_success_at, last_failure_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (channel) DO UPDATE
           SET status          = EXCLUDED.status,
               success_count   = EXCLUDED.success_count,
               failure_count   = EXCLUDED.failure_count,
               avg_duration_ms = EXCLUDED.avg_duration_ms,
               last_error      = EXCLUDED.last_error,
               last_success_at = EXCLUDED.last_success_at,
               last_failure_at = EXCLUDED.last_failure_at,
               checked_at      = NOW()`,
        [
          channel.channel,
          channel.status,
          channel.successCount,
          channel.failureCount,
          channel.avgDurationMs,
          channel.lastError,
          channel.lastSuccessAt,
          channel.lastFailureAt,
        ],
      );
    } catch (error) {
      logger.warn(
        { error, channel: channel.channel },
        "[notification-health] failed to snapshot channel health",
      );
    }
  }

  return health;
}

/**
 * Record every delivery in a batch without blocking the caller. Returns
 * immediately; failures are logged inside each promise.
 */
export function recordDeliveryAsync(record: DeliveryRecord): void {
  void recordDelivery(record);
}
