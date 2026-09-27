import { MTNProvider } from "../services/mobilemoney/providers/mtn";
import { AirtelService } from "../services/mobilemoney/providers/airtel";
import { OrangeProvider } from "../services/mobilemoney/providers/orange";
import {
  AccountingConnection,
  AccountingProvider,
  AccountingService,
} from "../services/accounting";

// ============================================================================
// Provider Token Watchdog
// ============================================================================
//
// Scheduled every 5 minutes. Detects the ways provider authentication can
// silently break BEFORE it interrupts service:
//
// 1. Mobile money credentials (MTN/Airtel/Orange API keys) revoked or expired:
//    probes each provider's auth endpoint with the real credentials and treats
//    a 401/403 as "credentials invalid". The uptime watchdog treats any HTTP
//    <500 (including 401/403) as healthy, so it cannot see this — an expired
//    credential would otherwise only surface when real transactions fail.
//
// 2. Accounting OAuth tokens (Xero / QuickBooks):
//    - access token already expired (the scheduled refresh failed) → one
//      auto-heal refresh attempt; if that fails, raises a CRITICAL incident
//      that manual re-authorization is required;
//    - refresh token stale (approaching the provider's inactivity window:
//      Xero 60 days, QuickBooks 100 days) → sends a warning webhook alert so
//      the integration is reused or reconnected before the token dies.
//
// Critical findings page PagerDuty; warnings go to webhook(s). The PagerDuty
// events use dedup keys so repeated runs do not re-page while an incident is
// active, and incidents auto-resolve once the condition clears.
// ============================================================================

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProviderName = "mtn" | "airtel" | "orange";

interface CredentialProbe {
  success: boolean;
  invalidCredentials?: boolean;
  error?: unknown;
}

interface IncidentRecord {
  subject: string;
  triggeredAt: string;
  dedupeKey: string;
}

interface StaleTokenAlertPayload {
  alertType: "provider_token_stale";
  severity: "warning";
  generatedAt: string;
  connections: Array<{
    connectionId: string;
    provider: AccountingProvider;
    daysSinceRefresh: number;
    refreshTokenLimitDays: number;
    action: string;
  }>;
}

// ─── Module-level incident state ──────────────────────────────────────────────
// Persists across cron invocations within the same process so incidents are
// not re-triggered on every run, and resolve when the condition clears.

function dedupPrefix(): string {
  return process.env.PAGERDUTY_DEDUP_KEY ?? "proxypay-token-watchdog";
}

const credentialIncidents = new Map<ProviderName, IncidentRecord>();
const reauthIncidents = new Map<string, IncidentRecord>();
const staleWarnedAt = new Map<string, number>();

// ─── Accounting refresh-token windows ─────────────────────────────────────────
// OAuth refresh tokens for accounting providers expire after a period of
// inactivity. Each successful refresh resets the clock; once the window lapses
// the only recovery is a manual re-authorization.

const XERO_REFRESH_TOKEN_LIMIT_DAYS = 60;
const QUICKBOOKS_REFRESH_TOKEN_LIMIT_DAYS = 100;
const REFRESH_TOKEN_WARN_LEAD_DAYS = 15; // warn this many days before the limit

const DAY_MS = 24 * 60 * 60 * 1000;

function refreshTokenLimitDays(provider: AccountingProvider): number {
  return provider === AccountingProvider.XERO
    ? XERO_REFRESH_TOKEN_LIMIT_DAYS
    : QUICKBOOKS_REFRESH_TOKEN_LIMIT_DAYS;
}

function staleWarnDays(provider: AccountingProvider): number {
  return refreshTokenLimitDays(provider) - REFRESH_TOKEN_WARN_LEAD_DAYS;
}

function staleRealertIntervalMs(): number {
  const hours = Number(process.env.PROVIDER_TOKEN_STALE_REALERT_HOURS ?? 24);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

// ─── PagerDuty helpers ────────────────────────────────────────────────────────

const PAGERDUTY_API = "https://events.pagerduty.com/v2/enqueue";

function integrationKey(): string {
  return process.env.PAGERDUTY_INTEGRATION_KEY ?? "";
}

interface PagerDutyPayload {
  routing_key: string;
  event_action: "trigger" | "resolve";
  dedup_key: string;
  payload: {
    summary: string;
    timestamp: string;
    severity: "critical" | "warning" | "info";
    source: string;
    custom_details: Record<string, unknown>;
  };
}

async function sendPagerDutyEvent(body: PagerDutyPayload): Promise<void> {
  if (!integrationKey()) {
    log(
      "warn",
      "PAGERDUTY_INTEGRATION_KEY not set — skipping PagerDuty event",
      { event_action: body.event_action, dedup_key: body.dedup_key },
    );
    return;
  }

  const response = await fetch(PAGERDUTY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `PagerDuty API responded with HTTP ${response.status}: ${await response.text()}`,
    );
  }
}

async function triggerPagerDutyIncident(
  incident: IncidentRecord,
  summary: string,
  customDetails: Record<string, unknown>,
): Promise<void> {
  await sendPagerDutyEvent({
    routing_key: integrationKey(),
    event_action: "trigger",
    dedup_key: incident.dedupeKey,
    payload: {
      summary,
      timestamp: new Date().toISOString(),
      severity: "critical",
      source: "provider-token-watchdog",
      custom_details: {
        environment: process.env.NODE_ENV ?? "development",
        ...customDetails,
      },
    },
  });
}

async function resolvePagerDutyIncident(
  incident: IncidentRecord,
): Promise<void> {
  await sendPagerDutyEvent({
    routing_key: integrationKey(),
    event_action: "resolve",
    dedup_key: incident.dedupeKey,
    payload: {
      summary: `[RESOLVED] ${incident.subject}`,
      timestamp: new Date().toISOString(),
      severity: "info",
      source: "provider-token-watchdog",
      custom_details: { environment: process.env.NODE_ENV ?? "development" },
    },
  });
}

// ─── Webhook helpers (warning-level alerts) ───────────────────────────────────

function resolveWarningWebhookUrls(): string[] {
  const values = [
    process.env.PROVIDER_TOKEN_ALERT_WEBHOOK_URL,
    process.env.SLACK_ALERTS_WEBHOOK_URL,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return [...new Set(values)];
}

async function postWebhookAlert(
  url: string,
  payload: StaleTokenAlertPayload,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook responded with HTTP ${response.status}`);
  }
}

// ─── Structured logger ────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

function log(
  level: LogLevel,
  message: string,
  meta: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "provider-token-watchdog",
    message,
    ...meta,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ─── Mobile money credential probes ───────────────────────────────────────────

const CREDENTIAL_CHECKS: Array<{
  name: ProviderName;
  check: () => Promise<CredentialProbe>;
}> = [
  { name: "mtn", check: () => new MTNProvider().checkAuth() },
  { name: "airtel", check: () => new AirtelService().checkAuth() },
  { name: "orange", check: () => new OrangeProvider().checkAuth() },
];

/**
 * Probes each mobile money provider's auth endpoint with real credentials.
 *
 * - 401/403 → trigger a CRITICAL "credentials invalid" incident (deduped per
 *   provider) and keep it active until a probe succeeds again.
 * - success → resolve any active credential incident.
 * - other failures (network / 5xx) → ignored here; the uptime watchdog owns
 *   "provider down" classification.
 */
export async function checkMobileMoneyCredentials(): Promise<void> {
  for (const { name, check } of CREDENTIAL_CHECKS) {
    let probe: CredentialProbe;
    try {
      probe = await check();
    } catch (error) {
      log("error", "Credential probe crashed", {
        provider: name,
        reason: toErrorMessage(error),
      });
      continue;
    }

    if (probe.invalidCredentials) {
      const active = credentialIncidents.get(name);
      if (active) {
        log("warn", "Provider credentials still invalid — incident already active", {
          provider: name,
          activeSince: active.triggeredAt,
        });
        continue;
      }

      const now = new Date().toISOString();
      const incident: IncidentRecord = {
        subject: `Mobile money provider ${name.toUpperCase()} rejected our credentials`,
        triggeredAt: now,
        dedupeKey: `${dedupPrefix()}-${name}-credentials`,
      };

      try {
        await triggerPagerDutyIncident(
          incident,
          `[CRITICAL] ${name.toUpperCase()} credentials expired or revoked — manual refresh required`,
          {
            provider: name,
            status: "invalid_credentials",
            detectedAt: now,
          },
        );
        credentialIncidents.set(name, incident);
        log("error", "Provider credential incident triggered", {
          provider: name,
          dedupeKey: incident.dedupeKey,
        });
      } catch (error) {
        log("error", "Failed to trigger credential incident", {
          provider: name,
          reason: toErrorMessage(error),
        });
      }
    } else if (probe.success) {
      const incident = credentialIncidents.get(name);
      if (!incident) continue;

      try {
        await resolvePagerDutyIncident(incident);
        credentialIncidents.delete(name);
        log("info", "Provider credential incident resolved", { provider: name });
      } catch (error) {
        log("error", "Failed to resolve credential incident", {
          provider: name,
          reason: toErrorMessage(error),
        });
      }
    } else {
      log("info", "Provider auth unreachable — not a credentials issue", {
        provider: name,
      });
    }
  }
}

// ─── Accounting token checks ──────────────────────────────────────────────────

/**
 * Checks all active accounting connections for dead or dying OAuth tokens.
 *
 * - `expires_at` in the past (the scheduled refresh already failed) → one
 *   auto-heal refresh attempt; on failure, raise a CRITICAL incident that
 *   manual re-authorization is required (deduped per connection).
 * - refresh token stale (no refresh within the provider's inactivity window)
 *   → warning webhook alert, re-alerted at most once per
 *   PROVIDER_TOKEN_STALE_REALERT_HOURS.
 */
export async function checkAccountingTokens(): Promise<void> {
  const accountingService = new AccountingService();

  let connections: AccountingConnection[];
  try {
    connections = await accountingService.getAllActiveConnections();
  } catch (error) {
    log("error", "Failed to load accounting connections", {
      reason: toErrorMessage(error),
    });
    return;
  }

  if (connections.length === 0) {
    log("info", "No active accounting connections to check");
    return;
  }

  const now = Date.now();

  for (const connection of connections) {
    const expiresAt = connection.expiresAt.getTime();

    // Resolve a previous re-authorization incident once the connection heals
    // (e.g. the user reconnected through the OAuth flow).
    const activeReauth = reauthIncidents.get(connection.id);
    if (activeReauth && expiresAt > now) {
      try {
        await resolvePagerDutyIncident(activeReauth);
        reauthIncidents.delete(connection.id);
        log("info", "Accounting re-authorization incident resolved", {
          connectionId: connection.id,
        });
      } catch (error) {
        log("error", "Failed to resolve re-authorization incident", {
          connectionId: connection.id,
          reason: toErrorMessage(error),
        });
      }
    }

    if (expiresAt <= now) {
      await handleExpiredAccountingToken(accountingService, connection);
      continue;
    }

    const lastRefreshMs = connection.updatedAt.getTime();
    if (now - lastRefreshMs > staleWarnDays(connection.provider) * DAY_MS) {
      await warnStaleAccountingToken(connection, now, lastRefreshMs);
    } else {
      // Recovered — allow future stale warnings if it goes stale again.
      staleWarnedAt.delete(connection.id);
    }
  }
}

async function handleExpiredAccountingToken(
  accountingService: AccountingService,
  connection: AccountingConnection,
): Promise<void> {
  if (reauthIncidents.has(connection.id)) {
    log("warn", "Accounting token still expired — re-authorization incident already active", {
      connectionId: connection.id,
      provider: connection.provider,
    });
    return;
  }

  try {
    if (connection.provider === AccountingProvider.XERO) {
      await accountingService.refreshXeroToken(connection.id);
    } else {
      await accountingService.refreshQuickBooksToken(connection.id);
    }
    log("info", "Auto-healed expired accounting access token", {
      connectionId: connection.id,
      provider: connection.provider,
    });
  } catch (error) {
    const now = new Date().toISOString();
    const incident: IncidentRecord = {
      subject: `Accounting connection ${connection.id} (${connection.provider}) requires manual re-authorization`,
      triggeredAt: now,
      dedupeKey: `${dedupPrefix()}-accounting-${connection.id}-reauth`,
    };

    try {
      await triggerPagerDutyIncident(
        incident,
        `[CRITICAL] ${connection.provider} refresh token expired or revoked for connection ${connection.id} — manual re-authorization required`,
        {
          provider: connection.provider,
          connectionId: connection.id,
          status: "refresh_failed",
          error: toErrorMessage(error),
          detectedAt: now,
        },
      );
      reauthIncidents.set(connection.id, incident);
      log("error", "Accounting re-authorization incident triggered", {
        connectionId: connection.id,
        provider: connection.provider,
        dedupeKey: incident.dedupeKey,
      });
    } catch (triggerError) {
      log("error", "Failed to trigger re-authorization incident", {
        connectionId: connection.id,
        reason: toErrorMessage(triggerError),
      });
    }
  }
}

async function warnStaleAccountingToken(
  connection: AccountingConnection,
  now: number,
  lastRefreshMs: number,
): Promise<void> {
  const lastWarnedAt = staleWarnedAt.get(connection.id);
  if (lastWarnedAt && now - lastWarnedAt < staleRealertIntervalMs()) {
    return;
  }

  const webhookUrls = resolveWarningWebhookUrls();
  if (webhookUrls.length === 0) {
    log(
      "warn",
      "Stale accounting refresh token detected but no alert webhook URL is configured",
      { connectionId: connection.id, provider: connection.provider },
    );
    staleWarnedAt.set(connection.id, now); // avoid spamming the logs
    return;
  }

  const daysSinceRefresh = Math.floor((now - lastRefreshMs) / DAY_MS);
  const payload: StaleTokenAlertPayload = {
    alertType: "provider_token_stale",
    severity: "warning",
    generatedAt: new Date().toISOString(),
    connections: [
      {
        connectionId: connection.id,
        provider: connection.provider,
        daysSinceRefresh,
        refreshTokenLimitDays: refreshTokenLimitDays(connection.provider),
        action:
          "Reuse or reconnect this integration before the refresh token expires",
      },
    ],
  };

  for (const webhookUrl of webhookUrls) {
    try {
      await postWebhookAlert(webhookUrl, payload);
    } catch (error) {
      log("error", "Failed to send stale token warning", {
        connectionId: connection.id,
        webhookUrl,
        reason: toErrorMessage(error),
      });
    }
  }

  staleWarnedAt.set(connection.id, now);
  log("warn", "Warned about stale accounting refresh token", {
    connectionId: connection.id,
    provider: connection.provider,
    daysSinceRefresh,
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Provider Token Watchdog — runs every 5 minutes via the cron scheduler.
 *
 * Detects expired/revoked provider credentials (mobile money) and dead or
 * dying accounting OAuth tokens before they interrupt service, and alerts via
 * PagerDuty (critical) and webhook (warning).
 */
export async function runProviderTokenWatchdogJob(): Promise<void> {
  log("info", "Provider token watchdog starting");

  await checkMobileMoneyCredentials();
  await checkAccountingTokens();

  log("info", "Provider token watchdog finished", {
    activeCredentialIncidents: [...credentialIncidents.keys()],
    activeReauthIncidents: [...reauthIncidents.keys()],
  });
}

// ─── Test-only helpers ────────────────────────────────────────────────────────
// Prefixed with _ to signal they are not part of the public API.

/** Returns a snapshot of active mobile-money credential incidents. */
export function getActiveCredentialIncidents(): ReadonlyMap<
  ProviderName,
  IncidentRecord
> {
  return credentialIncidents;
}

/** Returns a snapshot of active accounting re-authorization incidents. */
export function getActiveReauthIncidents(): ReadonlyMap<
  string,
  IncidentRecord
> {
  return reauthIncidents;
}

/** Clears all tracked incident state — use only in tests. */
export function _resetWatchdogState(): void {
  credentialIncidents.clear();
  reauthIncidents.clear();
  staleWarnedAt.clear();
}
