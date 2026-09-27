/**
 * Secure Session Timeout Middleware
 *
 * Provides server-side session timeout tracking with:
 * - Configurable idle timeout per user tier
 * - Warning notification before timeout
 * - Session refresh within warning period
 * - Graceful session termination
 *
 * Configuration (env vars)
 * ------------------------
 * SESSION_IDLE_TIMEOUT_FREE       – timeout for free tier (default: 1800 = 30min)
 * SESSION_IDLE_TIMEOUT_PRO        – timeout for pro tier (default: 3600 = 1hr)
 * SESSION_IDLE_TIMEOUT_ENTERPRISE – timeout for enterprise tier (default: 7200 = 2hr)
 * SESSION_WARNING_SECONDS         – seconds before timeout to send warning (default: 300 = 5min)
 * SESSION_REFRESH_ENDPOINT        – path for refresh endpoint (default: /api/auth/refresh)
 */

import { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";

// ── Types ─────────────────────────────────────────────────────────────────────

export type UserTier = "free" | "pro" | "enterprise";

export interface SessionTimeoutConfig {
  /** Idle timeout in seconds per tier. */
  timeouts: Record<UserTier, number>;
  /** Seconds before timeout to send warning. */
  warningSeconds: number;
  /** Redis key prefix. */
  keyPrefix: string;
}

export interface SessionActivity {
  lastActivity: number;
  timeoutAt: number;
  warningSent: boolean;
  tier: UserTier;
}

// ── Configuration ─────────────────────────────────────────────────────────────

function loadConfig(): SessionTimeoutConfig {
  return {
    timeouts: {
      free: parseInt(process.env.SESSION_IDLE_TIMEOUT_FREE ?? "1800", 10),
      pro: parseInt(process.env.SESSION_IDLE_TIMEOUT_PRO ?? "3600", 10),
      enterprise: parseInt(process.env.SESSION_IDLE_TIMEOUT_ENTERPRISE ?? "7200", 10),
    },
    warningSeconds: parseInt(process.env.SESSION_WARNING_SECONDS ?? "300", 10),
    keyPrefix: "session_timeout:",
  };
}

// ── Redis operations ──────────────────────────────────────────────────────────

async function getSessionActivity(
  sessionId: string,
  config: SessionTimeoutConfig,
): Promise<SessionActivity | null> {
  try {
    const data = await redisClient.hGetAll(`${config.keyPrefix}${sessionId}`);
    if (!data.lastActivity) return null;
    return {
      lastActivity: parseInt(data.lastActivity, 10),
      timeoutAt: parseInt(data.timeoutAt, 10),
      warningSent: data.warningSent === "true",
      tier: (data.tier as UserTier) || "free",
    };
  } catch {
    return null;
  }
}

async function setSessionActivity(
  sessionId: string,
  activity: SessionActivity,
  config: SessionTimeoutConfig,
): Promise<void> {
  try {
    const ttl = Math.max(activity.timeoutAt - Date.now(), 60);
    await redisClient.hSet(`${config.keyPrefix}${sessionId}`, {
      lastActivity: String(activity.lastActivity),
      timeoutAt: String(activity.timeoutAt),
      warningSent: String(activity.warningSent),
      tier: activity.tier,
    });
    await redisClient.expire(`${config.keyPrefix}${sessionId}`, Math.ceil(ttl / 1000));
  } catch {
    // Redis failure – session tracking won't work but request can proceed
  }
}

async function deleteSessionActivity(
  sessionId: string,
  config: SessionTimeoutConfig,
): Promise<void> {
  try {
    await redisClient.del(`${config.keyPrefix}${sessionId}`);
  } catch {
    // Ignored
  }
}

// ── In-memory fallback ────────────────────────────────────────────────────────

const inMemorySessions = new Map<string, SessionActivity>();

function getInMemoryActivity(
  sessionId: string,
  tier: UserTier,
  timeoutMs: number,
): SessionActivity {
  const existing = inMemorySessions.get(sessionId);
  if (existing) return existing;

  const now = Date.now();
  const activity: SessionActivity = {
    lastActivity: now,
    timeoutAt: now + timeoutMs,
    warningSent: false,
    tier,
  };
  inMemorySessions.set(sessionId, activity);
  return activity;
}

// Periodically clean up expired in-memory sessions
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of inMemorySessions) {
    if (value.timeoutAt < now) {
      inMemorySessions.delete(key);
    }
  }
}, 60_000);

// ── Tier resolution ───────────────────────────────────────────────────────────

/**
 * Resolve user tier from JWT claims or request metadata.
 * Override this function to implement custom tier logic.
 */
function resolveUserTier(req: Request): UserTier {
  const user = (req as any).jwtUser || (req as any).user;
  if (!user) return "free";

  const role = user.role?.toLowerCase();
  if (role === "enterprise" || role === "admin") return "enterprise";
  if (role === "pro" || role === "merchant") return "pro";
  return "free";
}

// ── Session ID extraction ─────────────────────────────────────────────────────

function extractSessionId(req: Request): string | null {
  // Try JWT user ID first
  const user = (req as any).jwtUser;
  if (user?.userId) return `jwt:${user.userId}`;

  // Try session ID
  const session = (req as any).session;
  if (session?.id) return `sess:${session.id}`;

  // Try API key
  const apiKey = req.header("X-API-Key");
  if (apiKey) return `apikey:${apiKey.slice(0, 8)}`;

  // Fall back to IP + User-Agent fingerprint
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const ua = req.header("user-agent") || "unknown";
  return `ip:${ip}:${Buffer.from(ua).toString("base64").slice(0, 16)}`;
}

// ── Warning mechanism ─────────────────────────────────────────────────────────

function sendTimeoutWarning(
  res: Response,
  secondsUntilTimeout: number,
  sessionId: string,
): void {
  // Set headers that the frontend can intercept
  res.setHeader("X-Session-Timeout-Warning", "true");
  res.setHeader("X-Session-Timeout-Remaining", String(secondsUntilTimeout));
  res.setHeader(
    "X-Session-Timeout-Message",
    `Your session will expire in ${secondsUntilTimeout} seconds. ` +
      `Please save your work or refresh the session.`,
  );
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * Middleware that tracks session activity and enforces idle timeout.
 *
 * - On each authenticated request, updates the session's last activity timestamp.
 * - If the session has been idle too long, terminates it with 401.
 * - If the session is within the warning window, adds warning headers.
 * - Supports session refresh via POST to the refresh endpoint.
 */
export function sessionTimeoutMiddleware(
  configOverrides: Partial<SessionTimeoutConfig> = {},
) {
  const baseConfig = loadConfig();
  const config: SessionTimeoutConfig = { ...baseConfig, ...configOverrides };

  return async function sessionTimeout(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const sessionId = extractSessionId(req);
    if (!sessionId) {
      next();
      return;
    }

    const tier = resolveUserTier(req);
    const timeoutMs = config.timeouts[tier] * 1000;
    const now = Date.now();

    // Check if this is a session refresh request
    const isRefresh = req.method === "POST" && req.path === "/api/auth/refresh";

    // Get or create session activity
    let activity = await getSessionActivity(sessionId, config);
    if (!activity) {
      activity = getInMemoryActivity(sessionId, tier, timeoutMs);
      activity.lastActivity = now;
      activity.timeoutAt = now + timeoutMs;
      activity.warningSent = false;
      activity.tier = tier;
    }

    // Check if session has expired
    if (now > activity.timeoutAt) {
      // Session expired
      await deleteSessionActivity(sessionId, config);
      inMemorySessions.delete(sessionId);

      res.status(401).json({
        error: "Session expired",
        message: "Your session has expired due to inactivity. Please log in again.",
        code: "SESSION_TIMEOUT",
      });
      return;
    }

    // Check if warning should be sent
    const secondsUntilTimeout = Math.ceil((activity.timeoutAt - now) / 1000);
    if (
      secondsUntilTimeout <= config.warningSeconds &&
      !activity.warningSent
    ) {
      sendTimeoutWarning(res, secondsUntilTimeout, sessionId);
      activity.warningSent = true;
    }

    // Update last activity
    activity.lastActivity = now;
    activity.timeoutAt = now + timeoutMs;

    // If refresh request, reset warning state
    if (isRefresh) {
      activity.warningSent = false;
    }

    await setSessionActivity(sessionId, activity, config);

    // Add session info headers
    res.setHeader("X-Session-Timeout", String(config.timeouts[tier]));
    res.setHeader("X-Session-Remaining", String(secondsUntilTimeout));

    next();
  };
}

/**
 * Middleware to explicitly terminate a session.
 * Use on logout endpoints.
 */
export function terminateSessionMiddleware() {
  return async function terminateSession(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const sessionId = extractSessionId(req);
    if (sessionId) {
      const config = loadConfig();
      await deleteSessionActivity(sessionId, config);
      inMemorySessions.delete(sessionId);
    }
    next();
  };
}

/**
 * Get session timeout configuration for a specific tier.
 * Useful for displaying timeout info in the UI.
 */
export function getSessionTimeoutForTier(tier: UserTier): number {
  const config = loadConfig();
  return config.timeouts[tier];
}
