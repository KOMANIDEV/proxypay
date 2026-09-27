import { AirtelService } from "../services/mobilemoney/providers/airtel";
import { OrangeProvider } from "../services/mobilemoney/providers/orange";

// ============================================================================
// Provider Session Refresh Job
// ============================================================================
//
// Runs every 5 minutes.  For each mobile-money provider that uses web-session
// authentication (Airtel web mode, Orange web mode), it:
//
//   1. Inspects the cached session's remaining TTL.
//   2. If the session will expire within PROACTIVE_REFRESH_LEAD_MS (default:
//      1 hour), it attempts a lightweight session refresh (POST /session/refresh).
//   3. If the refresh fails, it falls back to a full re-login.
//   4. Up to MAX_REFRESH_ATTEMPTS retries are made with exponential back-off
//      before the attempt is considered failed for this run.
//
// The job is intentionally decoupled from live request paths so that session
// overhead never adds latency to real transactions.
//
// Typical deployment: scheduled via node-cron in scheduler.ts alongside the
// other provider health-check jobs.
// ============================================================================

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How far ahead of session expiry to trigger a proactive refresh.
 * Defaults to 1 hour.  Override via PROVIDER_SESSION_REFRESH_LEAD_MS.
 */
const PROACTIVE_REFRESH_LEAD_MS = Number(
  process.env.PROVIDER_SESSION_REFRESH_LEAD_MS ?? 60 * 60 * 1000,
);

/**
 * Maximum number of refresh attempts per provider per job run.
 * Override via PROVIDER_SESSION_REFRESH_MAX_ATTEMPTS.
 */
const MAX_REFRESH_ATTEMPTS = Number(
  process.env.PROVIDER_SESSION_REFRESH_MAX_ATTEMPTS ?? 3,
);

/**
 * Base delay (ms) for exponential back-off between retry attempts.
 * Override via PROVIDER_SESSION_REFRESH_RETRY_BASE_MS.
 */
const RETRY_BASE_MS = Number(
  process.env.PROVIDER_SESSION_REFRESH_RETRY_BASE_MS ?? 2000,
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProviderSessionName = "airtel" | "orange";

interface RefreshOutcome {
  provider: ProviderSessionName;
  skipped: boolean;
  refreshed: boolean;
  reloggedIn: boolean;
  attempts: number;
  error?: unknown;
}

interface SessionRefreshJobResult {
  checkedAt: string;
  outcomes: RefreshOutcome[];
}

// ─── Lazy singleton providers ─────────────────────────────────────────────────
// We use lazily-initialised singletons so the job can be imported without side
// effects in tests, and so that all job invocations within a process share the
// same cached session state.

let _airtelInstance: AirtelService | null = null;
let _orangeInstance: OrangeProvider | null = null;

/** Returns the shared AirtelService singleton, creating it on first call. */
function getAirtelInstance(): AirtelService {
  if (!_airtelInstance) {
    _airtelInstance = new AirtelService();
  }
  return _airtelInstance;
}

/** Returns the shared OrangeProvider singleton, creating it on first call. */
function getOrangeInstance(): OrangeProvider {
  if (!_orangeInstance) {
    _orangeInstance = new OrangeProvider();
  }
  return _orangeInstance;
}

// Test-only: override the singletons so tests can inject mocks without
// touching module-level state across test suites.

/** @internal — inject a mock AirtelService in tests. */
export function _setAirtelInstance(instance: AirtelService | null): void {
  _airtelInstance = instance;
}

/** @internal — inject a mock OrangeProvider in tests. */
export function _setOrangeInstance(instance: OrangeProvider | null): void {
  _orangeInstance = instance;
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
    service: "provider-session-refresh",
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

// ─── Retry helpers ────────────────────────────────────────────────────────────

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculates exponential back-off delay for the given attempt number
 * (1-indexed), capped at 30 seconds.
 */
function backoffMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 30_000);
}

// ─── Per-provider refresh logic ───────────────────────────────────────────────

/**
 * Determines whether a session whose `expiresAt` (ms epoch) is within the
 * proactive refresh window.
 */
function needsProactiveRefresh(expiresAt: number, nowMs: number): boolean {
  return expiresAt - nowMs <= PROACTIVE_REFRESH_LEAD_MS;
}

interface ProactiveRefreshable {
  getSessionInfo(): { expiresAt: number } | null;
  proactivelyRefreshSession(): Promise<{
    success: boolean;
    reloggedIn?: boolean;
    error?: unknown;
  }>;
}

/**
 * Attempts up to `MAX_REFRESH_ATTEMPTS` times to refresh the session for the
 * given provider, with exponential back-off between attempts.
 *
 * Returns a `RefreshOutcome` summarising what happened.
 */
async function refreshWithRetry(
  providerName: ProviderSessionName,
  provider: ProactiveRefreshable,
  nowMs: number,
): Promise<RefreshOutcome> {
  const sessionInfo = provider.getSessionInfo();

  // Provider not in web mode or no session to inspect yet.
  if (!sessionInfo) {
    log("info", "Session refresh skipped — provider not in web mode or no active session", {
      provider: providerName,
    });
    return {
      provider: providerName,
      skipped: true,
      refreshed: false,
      reloggedIn: false,
      attempts: 0,
    };
  }

  const msUntilExpiry = sessionInfo.expiresAt - nowMs;
  const minutesUntilExpiry = Math.round(msUntilExpiry / 60_000);

  if (!needsProactiveRefresh(sessionInfo.expiresAt, nowMs)) {
    log("info", "Session still healthy — no proactive refresh needed", {
      provider: providerName,
      minutesUntilExpiry,
    });
    return {
      provider: providerName,
      skipped: true,
      refreshed: false,
      reloggedIn: false,
      attempts: 0,
    };
  }

  log("info", "Session approaching expiry — starting proactive refresh", {
    provider: providerName,
    minutesUntilExpiry,
    proactiveRefreshLeadMinutes: Math.round(PROACTIVE_REFRESH_LEAD_MS / 60_000),
  });

  let lastError: unknown;
  let lastResult: Awaited<ReturnType<ProactiveRefreshable["proactivelyRefreshSession"]>> | null =
    null;

  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
    try {
      const result = await provider.proactivelyRefreshSession();
      lastResult = result;

      if (result.success) {
        log("info", "Proactive session refresh succeeded", {
          provider: providerName,
          attempt,
          reloggedIn: result.reloggedIn ?? false,
        });
        return {
          provider: providerName,
          skipped: false,
          refreshed: true,
          reloggedIn: result.reloggedIn ?? false,
          attempts: attempt,
        };
      }

      // Provider returned success=false — treat as a failure and retry.
      lastError = result.error;
      log("warn", "Proactive session refresh returned failure", {
        provider: providerName,
        attempt,
        maxAttempts: MAX_REFRESH_ATTEMPTS,
        error: toErrorMessage(result.error),
      });
    } catch (error) {
      lastError = error;
      log("warn", "Proactive session refresh threw an exception", {
        provider: providerName,
        attempt,
        maxAttempts: MAX_REFRESH_ATTEMPTS,
        error: toErrorMessage(error),
      });
    }

    if (attempt < MAX_REFRESH_ATTEMPTS) {
      const waitMs = backoffMs(attempt);
      log("info", "Waiting before next refresh attempt", {
        provider: providerName,
        attempt,
        waitMs,
      });
      await delay(waitMs);
    }
  }

  log("error", "All proactive session refresh attempts exhausted", {
    provider: providerName,
    attempts: MAX_REFRESH_ATTEMPTS,
    error: toErrorMessage(lastError),
  });

  return {
    provider: providerName,
    skipped: false,
    refreshed: false,
    reloggedIn: lastResult?.reloggedIn ?? false,
    attempts: MAX_REFRESH_ATTEMPTS,
    error: lastError,
  };
}

// ─── Main job ─────────────────────────────────────────────────────────────────

/**
 * Provider Session Refresh Job — designed to run every 5 minutes via
 * node-cron.
 *
 * Checks the Airtel and Orange web-session providers and proactively refreshes
 * any session that will expire within the next hour (configurable via
 * `PROVIDER_SESSION_REFRESH_LEAD_MS`).  On failure it retries up to
 * `MAX_REFRESH_ATTEMPTS` times with exponential back-off; the final fallback
 * is a full re-login.
 */
export async function runProviderSessionRefreshJob(): Promise<SessionRefreshJobResult> {
  const checkedAt = new Date().toISOString();
  const nowMs = Date.now();

  log("info", "Provider session refresh job starting");

  const outcomes: RefreshOutcome[] = await Promise.all([
    refreshWithRetry("airtel", getAirtelInstance(), nowMs),
    refreshWithRetry("orange", getOrangeInstance(), nowMs),
  ]);

  const refreshed = outcomes.filter((o) => o.refreshed);
  const failed = outcomes.filter((o) => !o.skipped && !o.refreshed);
  const reloggedIn = outcomes.filter((o) => o.reloggedIn);

  log("info", "Provider session refresh job finished", {
    refreshedCount: refreshed.length,
    failedCount: failed.length,
    reloggedInCount: reloggedIn.length,
    providers: outcomes.map((o) => ({
      provider: o.provider,
      skipped: o.skipped,
      refreshed: o.refreshed,
      reloggedIn: o.reloggedIn,
      attempts: o.attempts,
      error: o.error ? toErrorMessage(o.error) : undefined,
    })),
  });

  return { checkedAt, outcomes };
}
