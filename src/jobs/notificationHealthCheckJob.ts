/**
 * #479 – Notification system failure alerting
 *
 * Evaluates per-channel health on a schedule and escalates on state
 * transitions only. Re-alerting on every tick would train operators to ignore
 * the alert, so a channel is announced when it *degrades* and again when it
 * recovers – never while it stays broken.
 */

import {
  getChannelHealth,
  snapshotChannelHealth,
  ChannelHealthStatus,
} from "../services/notificationHealthService";
import { notifySlackAlert } from "../services/loggers";

/** Previously observed status per channel, used to detect transitions. */
let lastStatus: Record<string, ChannelHealthStatus> = {};

export async function runNotificationHealthCheckJob(): Promise<void> {
  console.info("[notification-health] Checking notification system health");

  const health = await getChannelHealth();
  await snapshotChannelHealth();

  const transitions: Array<{
    channel: string;
    from: ChannelHealthStatus | "unknown";
    to: ChannelHealthStatus;
    detail: string;
  }> = [];

  for (const channel of health) {
    const previous = lastStatus[channel.channel];
    if (previous === channel.status) continue;

    // On the very first run there is no previous state: only report channels
    // that are actually unhealthy so a cold start does not page anyone.
    if (previous === undefined && channel.status === "healthy") continue;

    transitions.push({
      channel: channel.channel,
      from: previous ?? "unknown",
      to: channel.status,
      detail:
        `${channel.attempts} attempt(s), ` +
        `${(channel.successRate * 100).toFixed(1)}% success, ` +
        `${channel.avgDurationMs}ms avg` +
        (channel.lastError ? `, last error: ${channel.lastError}` : ""),
    });

    lastStatus[channel.channel] = channel.status;
  }

  if (transitions.length === 0) {
    console.info(
      "[notification-health] All channels stable - no transitions to report",
    );
    return;
  }

  const worsening = transitions.filter(
    (t) => t.to === "down" || (t.from === "healthy" && t.to === "degraded"),
  );
  const recovered = transitions.filter((t) => t.to === "healthy");

  for (const transition of worsening) {
    console.error(
      `[notification-health] ALERT: ${transition.channel} is ${transition.to} (${transition.detail})`,
    );
    await notifySlackAlert(
      {
        statusCode: 503,
        method: "MONITOR",
        path: `/notifications/status/${transition.channel}`,
        timestamp: new Date().toISOString(),
        error: new Error(
          `Notification channel "${transition.channel}" is ${transition.to} ` +
            `(was ${transition.from}): ${transition.detail}`,
        ),
      },
      { appName: "notification-health" },
    );
  }

  for (const transition of recovered) {
    console.info(
      `[notification-health] RECOVERED: ${transition.channel} is healthy again`,
    );
    await notifySlackAlert(
      {
        statusCode: 200,
        method: "MONITOR",
        path: `/notifications/status/${transition.channel}`,
        timestamp: new Date().toISOString(),
        error: new Error(
          `Notification channel "${transition.channel}" recovered ` +
            `(was ${transition.from}): ${transition.detail}`,
        ),
      },
      { appName: "notification-health" },
    );
  }
}

/** Test hook – clears the transition memory. */
export function _resetNotificationHealthState(): void {
  lastStatus = {};
}
