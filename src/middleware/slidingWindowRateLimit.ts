/**
 * Sliding-window rate limiter backed by Redis sorted sets.
 *
 * Algorithm
 * ---------
 * Each (identifier, group) pair owns a Redis sorted-set key where:
 *   - member  = "<timestamp>:<random>"   (unique per request)
 *   - score   = Unix timestamp in ms
 *
 * On every request a Lua script atomically:
 *   1. Removes members older than (now - windowMs).
 *   2. Counts remaining members.
 *   3. Rejects if count >= max; otherwise ZADDs the new entry.
 *   4. Refreshes the key TTL.
 *
 * Identifier precedence: API key (`x-api-key` header or `apiKey` JWT claim)
 * takes priority; unauthenticated requests fall back to the client IP.
 */

import { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";
import { rateLimitConfig, RouteGroup, RateLimitEntry } from "../config/rateLimitConfig";

// ---------------------------------------------------------------------------
// Lua script (atomic read-modify-write)
// ---------------------------------------------------------------------------
const SLIDING_WINDOW_SCRIPT = `
local key          = KEYS[1]
local now          = tonumber(ARGV[1])
local windowStart  = tonumber(ARGV[2])
local maxRequests  = tonumber(ARGV[3])
local member       = ARGV[4]
local ttlSeconds   = tonumber(ARGV[5])

redis.call("ZREMRANGEBYSCORE", key, 0, windowStart)
local count = tonumber(redis.call("ZCARD", key))

if count >= maxRequests then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local oldestScore = oldest[2] and tonumber(oldest[2]) or now
  redis.call("EXPIRE", key, ttlSeconds)
  return {0, count, oldestScore}
end

redis.call("ZADD", key, now, member)
count = count + 1
redis.call("EXPIRE", key, ttlSeconds)
return {1, count, now}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveIdentifier(req: Request): string {
  // 1. Explicit API key header
  const apiKeyHeader = req.headers["x-api-key"];
  if (apiKeyHeader) return `apikey:${apiKeyHeader}`;

  // 2. API key embedded in JWT claims
  const jwtApiKey = (req as any).jwtUser?.apiKey;
  if (jwtApiKey) return `apikey:${jwtApiKey}`;

  // 3. Fallback: IP address
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.ip ??
    "unknown";
  return `ip:${ip}`;
}

interface WindowResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;   // absolute epoch ms when window resets for this identifier
  limit: number;
}

async function checkSlidingWindow(
  key: string,
  entry: RateLimitEntry,
): Promise<WindowResult> {
  const now = Date.now();
  const windowStart = now - entry.windowMs;
  const ttlSeconds = Math.ceil(entry.windowMs / 1000) + 10;
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

  if (!redisClient.isOpen) {
    // Redis unavailable – fail open to avoid blocking all traffic
    return { allowed: true, remaining: entry.max, resetMs: now + entry.windowMs, limit: entry.max };
  }

  const raw = (await redisClient.sendCommand([
    "EVAL",
    SLIDING_WINDOW_SCRIPT,
    "1",
    key,
    String(now),
    String(windowStart),
    String(entry.max),
    member,
    String(ttlSeconds),
  ])) as [number | string, number | string, number | string];

  const allowed      = String(raw[0]) === "1";
  const count        = Number(raw[1]);
  const oldestScore  = Number(raw[2] ?? now);
  const resetMs      = oldestScore + entry.windowMs;

  return {
    allowed,
    limit: entry.max,
    remaining: allowed ? Math.max(0, entry.max - count) : 0,
    resetMs,
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware that enforces a sliding-window rate limit for
 * the given route group using the config from `rateLimitConfig.ts`.
 *
 * @example
 *   app.use("/api/auth", slidingWindowRateLimit("auth"), authRoutes);
 */
export function slidingWindowRateLimit(
  group: RouteGroup,
  customEntry?: RateLimitEntry,
) {
  const entry = customEntry ?? rateLimitConfig[group];

  return async function slidingWindowRateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const identifier = resolveIdentifier(req);
    const key = `rl:${group}:${identifier}`;

    let result: WindowResult;
    try {
      result = await checkSlidingWindow(key, entry);
    } catch (err) {
      console.error("[slidingWindowRateLimit] Redis error – failing open", err);
      return next();
    }

    const resetEpochSeconds = Math.ceil(result.resetMs / 1000);

    res.setHeader("X-RateLimit-Limit",     String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset",     String(resetEpochSeconds));

    if (!result.allowed) {
      const retryAfter = Math.max(1, resetEpochSeconds - Math.floor(Date.now() / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "Too Many Requests",
        message: `Rate limit exceeded for ${group} endpoints. Retry after ${retryAfter}s.`,
      });
      return;
    }

    next();
  };
}
