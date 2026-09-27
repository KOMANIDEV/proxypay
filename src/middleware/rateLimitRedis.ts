import { Request, Response, NextFunction } from "express";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { redisClient } from "../config/redis";

// Define tiers
export type UserTier = "free" | "pro" | "enterprise";

export interface TierConfig {
  points: number;
  duration: number;
  keyPrefix: string;
  burstSize: number;
}

export const TIER_CONFIGS: Record<UserTier, TierConfig> = {
  free: {
    points: 100,
    duration: 60,
    keyPrefix: "rl_free",
    burstSize: 20,
  },
  pro: {
    points: 1000,
    duration: 60,
    keyPrefix: "rl_pro",
    burstSize: 200,
  },
  enterprise: {
    points: 10000,
    duration: 60,
    keyPrefix: "rl_enterprise",
    burstSize: 2000,
  },
};

const limiters = new Map<UserTier, RateLimiterRedis>();

function getLimiter(tier: UserTier): RateLimiterRedis {
  if (!limiters.has(tier)) {
    const config = TIER_CONFIGS[tier];
    limiters.set(tier, new RateLimiterRedis({
      storeClient: redisClient,
      points: config.points,
      duration: config.duration,
      keyPrefix: config.keyPrefix,
      blockDuration: 0,
    }));
  }
  return limiters.get(tier)!;
}

function getTier(req: Request): UserTier {
  const user = req.user as any;
  const jwtUser = req.jwtUser as any;
  
  const tier = user?.tier || jwtUser?.tier || "free";
  
  if (["free", "pro", "enterprise"].includes(tier)) {
    return tier as UserTier;
  }
  
  return "free";
}

function getApiKey(req: Request): string | null {
  return (req.headers["x-api-key"] as string) || null;
}

// ─── Rate Limit Usage Tracking ────────────────────────────────────────────────

export interface RateLimitUsage {
  tier: UserTier;
  limit: number;
  remaining: number;
  resetAt: string;
  apiKey?: string;
}

export async function getRateLimitUsage(
  req: Request,
): Promise<RateLimitUsage> {
  const tier = getTier(req);
  const userId = req.jwtUser?.userId || req.user?.id;
  const apiKey = getApiKey(req);
  const key = apiKey
    ? `rl_apikey:${apiKey}`
    : userId
      ? `${tier}:${userId}`
      : `${tier}:ip:${req.ip}`;

  const config = TIER_CONFIGS[tier];

  try {
    const result = await redisClient.sendCommand([
      "PTTL",
      `${config.keyPrefix}:${key}`,
    ]);
    const ttlMs = Number(result);
    const resetAt = ttlMs > 0
      ? new Date(Date.now() + ttlMs).toISOString()
      : new Date(Date.now() + config.duration * 1000).toISOString();

    // Get current usage from the sorted set count
    const intRes = await redisClient.sendCommand([
      "GET",
      `${config.keyPrefix}:${key}`,
    ]);

    return {
      tier,
      limit: config.points,
      remaining: Math.max(0, config.points - Number(intRes || 0)),
      resetAt,
      apiKey: apiKey ?? undefined,
    };
  } catch {
    return {
      tier,
      limit: config.points,
      remaining: config.points,
      resetAt: new Date(Date.now() + config.duration * 1000).toISOString(),
    };
  }
}

// ─── Graceful Degradation: Queue Mode ─────────────────────────────────────────

const QUEUE_ENABLED = process.env.RATE_LIMIT_QUEUE_ENABLED === "true";
const QUEUE_MAX_SIZE = parseInt(process.env.RATE_LIMIT_QUEUE_MAX_SIZE || "100", 10);
const QUEUE_TIMEOUT_MS = parseInt(process.env.RATE_LIMIT_QUEUE_TIMEOUT_MS || "5000", 10);

interface QueuedRequest {
  req: Request;
  res: Response;
  next: NextFunction;
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

const requestQueues = new Map<string, QueuedRequest[]>();

function processQueue(key: string): void {
  const queue = requestQueues.get(key);
  if (!queue || queue.length === 0) return;

  const item = queue.shift()!;
  processQueue(key);

  const elapsed = Date.now() - item.enqueuedAt;
  if (elapsed > QUEUE_TIMEOUT_MS) {
    item.reject(new Error("Queue timeout"));
    return;
  }

  item.resolve();
}

// ─── Main Middleware ──────────────────────────────────────────────────────────

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip;
  const userId = req.jwtUser?.userId || req.user?.id;
  const tier = getTier(req);
  const apiKey = getApiKey(req);
  const key = apiKey
    ? `rl_apikey:${apiKey}`
    : userId
      ? `${tier}:${userId}`
      : `${tier}:ip:${ip}`;
  const limiter = getLimiter(tier);

  try {
    await limiter.consume(key);

    res.set("X-RateLimit-Limit", String(TIER_CONFIGS[tier].points));
    res.set("X-RateLimit-Remaining", String(Math.max(0, TIER_CONFIGS[tier].points - 1)));
    res.set("X-RateLimit-Tier", tier);

    next();
  } catch (rejRes) {
    const retrySecs = Math.round(rejRes.msBeforeNext / 1000) || 1;

    if (QUEUE_ENABLED) {
      const queueKey = `queue:${key}`;
      const queue = requestQueues.get(queueKey) || [];

      if (queue.length < QUEUE_MAX_SIZE) {
        return new Promise<void>((resolve, reject) => {
          queue.push({ req, res, next, resolve, reject, enqueuedAt: Date.now() });
          requestQueues.set(queueKey, queue);

          const timer = setTimeout(() => {
            const idx = queue.findIndex((q) => q.resolve === resolve);
            if (idx !== -1) queue.splice(idx, 1);
            reject(new Error("Queue timeout"));
          }, QUEUE_TIMEOUT_MS);

          resolve.then(() => {
            clearTimeout(timer);
            processQueue(queueKey);
            rateLimitMiddleware(req, res, next);
          }).catch(() => {
            clearTimeout(timer);
            res.status(429).json({
              error: "Too Many Requests",
              message: `Rate limit exceeded for ${tier} tier. Queue full or timed out.`,
              tier,
              limit: TIER_CONFIGS[tier].points,
              windowSeconds: TIER_CONFIGS[tier].duration,
            });
          });
        });
      }
    }

    res.set("Retry-After", String(retrySecs));
    res.set("X-RateLimit-Limit", String(TIER_CONFIGS[tier].points));
    res.set("X-RateLimit-Remaining", "0");
    res.set("X-RateLimit-Tier", tier);

    res.status(429).json({
      error: "Too Many Requests",
      message: `Rate limit exceeded for ${tier} tier. Try again in ${retrySecs} seconds.`,
      tier,
      limit: TIER_CONFIGS[tier].points,
      windowSeconds: TIER_CONFIGS[tier].duration,
    });
  }
}

export function getTierConfig(tier: UserTier): TierConfig {
  return TIER_CONFIGS[tier];
}

export function getTierFromRequest(req: Request): UserTier {
  return getTier(req);
}
