import { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";

/**
 * Rate Limit Configuration
 * These values can be easily tuned for different use cases
 */
export const RATE_LIMIT_CONFIG = {
  // Export endpoint: 5 requests per hour per admin
  EXPORT_LIMIT: 5,
  EXPORT_WINDOW_MS: 60 * 60 * 1000, // 1 hour in milliseconds

  // SEP-24 (Deposit/Withdrawal): 10 requests per minute per user
  SEP24_LIMIT: 10,
  SEP24_WINDOW_MS: 60 * 1000, // 1 minute

  // SEP-31 (Send Payment): 5 requests per minute per user
  SEP31_LIMIT: 5,
  SEP31_WINDOW_MS: 60 * 1000, // 1 minute

  // SEP-12 (KYC): 20 requests per hour per user
  SEP12_LIMIT: 20,
  SEP12_WINDOW_MS: 60 * 60 * 1000, // 1 hour

  // Cancellation rate limit: 5 cancellations per hour per user
  CANCELLATION_LIMIT: 5,
  CANCELLATION_WINDOW_MS: 60 * 60 * 1000, // 1 hour

  // SEP-30 key recovery (#572): deliberately the tightest limit in this file.
  // The recovery flow is the one place in the product where an unauthenticated
  // caller can drive a key rotation, and each approval attempt is a cheap
  // operation for the attacker and an expensive one for the operator: a
  // successful recovery locks every legitimate signer out of the key. 5 attempts
  // per 15 minutes leaves room for a real 3-of-5 ceremony and no room for
  // guessing.
  RECOVERY_LIMIT: 5,
  RECOVERY_WINDOW_MS: 15 * 60 * 1000, // 15 minutes

  // Asset issuance workflow (#571): 10 write operations per hour per admin.
  // Deliberately low. Every request in this workflow can create a real asset or
  // move funds once approved, so the thing being limited is a privileged,
  // irreversible action rather than a query.
  ASSET_ISSUANCE_LIMIT: 10,
  ASSET_ISSUANCE_WINDOW_MS: 60 * 60 * 1000, // 1 hour

  // List queries: warn when requesting more than 1000 items
  MASSIVE_LIST_THRESHOLD: 1000,

  // Suspicious queries: more than 50 items without pagination
  SUSPICIOUS_QUERY_THRESHOLD: 50,

  // Global rate limit: 200 requests per minute per IP
  GLOBAL_LIMIT: 200,
  GLOBAL_WINDOW_MS: 60 * 1000, // 1 minute
};

/**
 * Tier-based Rate Limit Configuration
 * Defines per-minute request limits for each user tier
 */
export const TIER_RATE_LIMITS = {
  free: { limit: 60, windowMs: 60 * 1000 },       // 60 req/min
  pro: { limit: 300, windowMs: 60 * 1000 },         // 300 req/min
  enterprise: { limit: 1000, windowMs: 60 * 1000 }, // 1000 req/min
} as const;

export type UserTier = keyof typeof TIER_RATE_LIMITS;

/**
 * Factory: creates a per-tier rate limit middleware.
 * Uses the Redis-based checkRateLimit helper with a tier-scoped key.
 *
 * @param tier - The user tier ('free' | 'pro' | 'enterprise')
 * @returns Express middleware that enforces the tier's rate limit
 */
export function createTierRateLimitMiddleware(tier: UserTier) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { limit, windowMs } = TIER_RATE_LIMITS[tier];
    const key = `tier-rate-limit:${tier}:${req.ip}`;
    const { allowed, remaining, resetTime } = await checkRateLimit(key, limit, windowMs);

    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

    if (!allowed) {
      const retryAfter = windowMs / 1000;
      res.setHeader("Retry-After", String(retryAfter));

      return res.status(429).json({
        error: "Rate limit exceeded",
        tier,
        retryAfter,
      });
    }

    next();
  };
}

/**
 * Per-endpoint rate limit configuration.
 *
 * Endpoints have very different sensitivity: a login attempt is brute-force
 * sensitive while webhook ingestion is machine traffic. Each entry is keyed by
 * `"<METHOD> <path>"` and may override the shared window with:
 *
 *  - `providerOverrides` — different mobile-money upstreams have different
 *    throughput characteristics (MTN vs Airtel vs Orange).
 *  - `tierOverrides`     — VIP customers get a larger allowance than standard.
 *
 * Precedence when resolving a request: tier override > provider override >
 * endpoint default > RATE_LIMIT_CONFIG global default.
 */
export type ProviderName = "mtn" | "airtel" | "orange" | "default";
export type AudienceTier = "standard" | "vip";
export type EndpointRateLimitKeyBy = "ip" | "user" | "provider";

export interface RateLimitWindow {
  limit: number;
  windowMs: number;
}

export interface EndpointRateLimitConfig extends RateLimitWindow {
  /** How the bucket key is scoped for this endpoint. Defaults to "ip". */
  keyBy?: EndpointRateLimitKeyBy;
  /** Provider-specific overrides (MTN / Airtel / Orange). */
  providerOverrides?: Partial<Record<ProviderName, RateLimitWindow>>;
  /** User-tier overrides (VIP vs standard). */
  tierOverrides?: Partial<Record<AudienceTier, RateLimitWindow>>;
}

export const RATE_LIMIT_PROVIDERS: readonly ProviderName[] = [
  "mtn",
  "airtel",
  "orange",
  "default",
];
export const RATE_LIMIT_TIERS: readonly AudienceTier[] = ["standard", "vip"];
export const ENDPOINT_RATE_LIMIT_KEY_BY: readonly EndpointRateLimitKeyBy[] = [
  "ip",
  "user",
  "provider",
];

export const ENDPOINT_RATE_LIMITS: Record<string, EndpointRateLimitConfig> = {
  // Brute-force sensitive auth endpoints — keyed per IP.
  "POST /api/auth/login": { limit: 10, windowMs: 60 * 1000, keyBy: "ip" },
  "POST /api/auth/2fa/verify": { limit: 10, windowMs: 60 * 1000, keyBy: "ip" },

  // Transaction creation: providers are throttled differently upstream and VIP
  // customers are allowed a much larger burst.
  "POST /api/transactions": {
    limit: 60,
    windowMs: 60 * 1000,
    keyBy: "user",
    providerOverrides: {
      mtn: { limit: 80, windowMs: 60 * 1000 },
      airtel: { limit: 50, windowMs: 60 * 1000 },
      orange: { limit: 40, windowMs: 60 * 1000 },
    },
    tierOverrides: {
      vip: { limit: 300, windowMs: 60 * 1000 },
    },
  },

  "GET /api/transactions": {
    limit: 120,
    windowMs: 60 * 1000,
    keyBy: "user",
    tierOverrides: {
      vip: { limit: 600, windowMs: 60 * 1000 },
    },
  },

  "GET /api/transactions/:id/receipt": {
    limit: 60,
    windowMs: 60 * 1000,
    keyBy: "user",
  },

  // Inbound provider callbacks: high-volume machine traffic keyed per IP.
  "POST /api/webhooks": { limit: 600, windowMs: 60 * 1000, keyBy: "ip" },

  // Heavy reporting endpoints keep a slow bucket regardless of tier.
  "GET /api/reports/export": {
    limit: 5,
    windowMs: 60 * 60 * 1000,
    keyBy: "user",
  },
};

const ENDPOINT_KEY_PATTERN = /^(GET|POST|PUT|PATCH|DELETE) \/\S+$/;

export interface RateLimitConfigValidationResult {
  valid: boolean;
  errors: string[];
}

function validateWindow(
  window: Partial<RateLimitWindow> | undefined,
  scope: string,
  errors: string[],
): void {
  if (!window) return;
  if (!Number.isInteger(window.limit) || (window.limit ?? 0) <= 0) {
    errors.push(`${scope}: limit must be a positive integer.`);
  }
  if (!Number.isInteger(window.windowMs) || (window.windowMs ?? 0) < 1000) {
    errors.push(`${scope}: windowMs must be an integer >= 1000.`);
  }
}

/**
 * Validates a per-endpoint configuration table. Called on module load so a bad
 * table fails fast at startup instead of at request time.
 */
export function validateRateLimitConfig(
  config: Record<string, EndpointRateLimitConfig> = ENDPOINT_RATE_LIMITS,
): RateLimitConfigValidationResult {
  const errors: string[] = [];

  if (
    !config ||
    typeof config !== "object" ||
    Object.keys(config).length === 0
  ) {
    return {
      valid: false,
      errors: ["Endpoint rate limit configuration is empty."],
    };
  }

  for (const [endpoint, rule] of Object.entries(config)) {
    if (!ENDPOINT_KEY_PATTERN.test(endpoint)) {
      errors.push(
        `"${endpoint}": expected "<METHOD> <path>", e.g. "POST /api/transactions".`,
      );
    }

    validateWindow(rule, `"${endpoint}"`, errors);

    if (rule.keyBy && !ENDPOINT_RATE_LIMIT_KEY_BY.includes(rule.keyBy)) {
      errors.push(
        `"${endpoint}": invalid keyBy "${rule.keyBy}" (expected ${ENDPOINT_RATE_LIMIT_KEY_BY.join(", ")}).`,
      );
    }

    for (const [provider, override] of Object.entries(
      rule.providerOverrides ?? {},
    )) {
      if (!RATE_LIMIT_PROVIDERS.includes(provider as ProviderName)) {
        errors.push(
          `"${endpoint}": unknown provider override "${provider}" (expected ${RATE_LIMIT_PROVIDERS.join(", ")}).`,
        );
      }
      validateWindow(override, `"${endpoint}" provider "${provider}"`, errors);
    }

    for (const [tier, override] of Object.entries(rule.tierOverrides ?? {})) {
      if (!RATE_LIMIT_TIERS.includes(tier as AudienceTier)) {
        errors.push(
          `"${endpoint}": unknown tier override "${tier}" (expected ${RATE_LIMIT_TIERS.join(", ")}).`,
        );
      }
      validateWindow(override, `"${endpoint}" tier "${tier}"`, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Throws when the per-endpoint table is invalid. */
export function assertValidRateLimitConfig(
  config: Record<string, EndpointRateLimitConfig> = ENDPOINT_RATE_LIMITS,
): void {
  const { valid, errors } = validateRateLimitConfig(config);
  if (!valid) {
    throw new Error(
      `Invalid rate limit configuration:\n - ${errors.join("\n - ")}`,
    );
  }
}

// Fail fast on startup — misconfigured limits should not reach production.
assertValidRateLimitConfig();

export interface ResolvedRateLimit extends RateLimitWindow {
  endpoint: string;
  keyBy: EndpointRateLimitKeyBy;
  provider: ProviderName;
  tier: AudienceTier;
  source: "tier-override" | "provider-override" | "endpoint" | "global-default";
}

/** Normalises free-form provider strings ("MTN MoMo", "mtn-momo") to a name. */
export function normaliseProvider(provider?: string | null): ProviderName {
  if (!provider) return "default";
  const value = provider.trim().toLowerCase().replace(/[\s_]/g, "-");
  if (value.startsWith("mtn")) return "mtn";
  if (value.startsWith("airtel")) return "airtel";
  if (value.startsWith("orange")) return "orange";
  return "default";
}

/** Maps a user tier onto the VIP / standard audience used by overrides. */
export function normaliseTier(tier?: string | null): AudienceTier {
  if (!tier) return "standard";
  const value = tier.trim().toLowerCase();
  return value === "vip" || value === "premium" ? "vip" : "standard";
}

/**
 * Resolves the effective limit for an endpoint, applying provider and tier
 * overrides. Unknown endpoints fall back to the global safety-net limit.
 */
export function resolveEndpointRateLimit(
  endpoint: string,
  options: { provider?: string | null; tier?: string | null } = {},
): ResolvedRateLimit {
  const provider = normaliseProvider(options.provider);
  const tier = normaliseTier(options.tier);
  const rule = ENDPOINT_RATE_LIMITS[endpoint];

  if (!rule) {
    return {
      endpoint,
      limit: RATE_LIMIT_CONFIG.GLOBAL_LIMIT,
      windowMs: RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS,
      keyBy: "ip",
      provider,
      tier,
      source: "global-default",
    };
  }

  const base: ResolvedRateLimit = {
    endpoint,
    limit: rule.limit,
    windowMs: rule.windowMs,
    keyBy: rule.keyBy ?? "ip",
    provider,
    tier,
    source: "endpoint",
  };

  const tierOverride = rule.tierOverrides?.[tier];
  if (tierOverride) {
    return {
      ...base,
      limit: tierOverride.limit,
      windowMs: tierOverride.windowMs,
      source: "tier-override",
    };
  }

  const providerOverride = rule.providerOverrides?.[provider];
  if (provider !== "default" && providerOverride) {
    return {
      ...base,
      limit: providerOverride.limit,
      windowMs: providerOverride.windowMs,
      source: "provider-override",
    };
  }

  return base;
}

/**
 * Interface for tracking rate limit data
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * In-memory store for rate limit tracking
 * In production, use Redis or similar for distributed systems
 */
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Check and increment rate limit using Redis
 */
async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
  try {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetTime = windowStart + windowMs;

    // Use Redis to atomically increment and check
    const count = await redisClient.incr(key);
    const countNum = typeof count === 'string' ? parseInt(count, 10) : count;

    // Set expiry on first request in this window
    if (countNum === 1) {
      await redisClient.pexpire(key, windowMs);
    }

    const allowed = countNum <= limit;
    const remaining = Math.max(0, limit - countNum);

    return { allowed, remaining, resetTime };
  } catch (error) {
    console.error("Rate limit Redis error:", error);
    // Fallback to in-memory if Redis fails
    return checkRateLimitInMemory(key, limit, windowMs);
  }
}

/**
 * Fallback in-memory rate limit check
 */
function checkRateLimitInMemory(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetTime) {
    // New window
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetTime: entry.resetTime };
  }

  entry.count++;
  return { allowed: true, remaining: limit - entry.count, resetTime: entry.resetTime };
}

/**
 * Log high-severity events
 */
const logHighSeverity = (message: string, context: Record<string, unknown>) => {
  console.error(`[RATE_LIMIT_BREACH] HIGH SEVERITY: ${message}`, {
    timestamp: new Date().toISOString(),
    ...context,
  });
};

/**
 * Generate a rate limit key based on user ID and endpoint
 */
const generateRateLimitKey = (userId: string, endpoint: string): string => {
  return `ratelimit:${userId}:${endpoint}`;
};

export interface EndpointRateLimiterOptions {
  /** Overrides how the provider is read from the request (defaults to params/query/body/headers). */
  getProvider?: (req: Request) => string | undefined;
  /** Overrides how the user tier is read from the request (defaults to req.user / req.jwtUser). */
  getTier?: (req: Request) => string | undefined;
}

function defaultProviderSelector(req: Request): string | undefined {
  const candidate = [
    req.params?.provider,
    req.query?.provider,
    (req.body as Record<string, unknown> | undefined)?.provider,
    req.headers["x-provider"],
    req.headers["x-provider-id"],
  ].find((value) => typeof value === "string" && value.trim().length > 0);

  return typeof candidate === "string" ? candidate : undefined;
}

function defaultTierSelector(req: Request): string | undefined {
  const user = (req as any).user ?? (req as any).jwtUser;
  if (!user) return undefined;
  if (user.isVip === true || user.vip === true) return "vip";
  return typeof user.tier === "string" ? user.tier : undefined;
}

function resolveRateLimitIdentity(
  req: Request,
  keyBy: EndpointRateLimitKeyBy,
  provider: ProviderName,
): string {
  if (keyBy === "provider") return provider;
  if (keyBy === "user") {
    const user = (req as any).user ?? (req as any).jwtUser;
    return String(user?.id ?? user?.userId ?? req.ip ?? "anonymous");
  }
  return req.ip ?? "unknown";
}

/**
 * Factory: creates a rate limit middleware for a single endpoint, honouring the
 * per-provider and per-tier overrides configured in {@link ENDPOINT_RATE_LIMITS}.
 *
 * @param endpoint - Endpoint key in `"<METHOD> <path>"` format.
 *
 * @example
 * router.post("/transactions", createEndpointRateLimiter("POST /api/transactions"), handler);
 */
export function createEndpointRateLimiter(
  endpoint: string,
  options: EndpointRateLimiterOptions = {},
) {
  const getProvider = options.getProvider ?? defaultProviderSelector;
  const getTier = options.getTier ?? defaultTierSelector;

  return async (req: Request, res: Response, next: NextFunction) => {
    const provider = normaliseProvider(getProvider(req));
    const tier = normaliseTier(getTier(req));
    const resolved = resolveEndpointRateLimit(endpoint, { provider, tier });
    const identity = resolveRateLimitIdentity(req, resolved.keyBy, provider);
    const key = `ratelimit:endpoint:${endpoint}:${provider}:${tier}:${identity}`;

    const { allowed, remaining, resetTime } = await checkRateLimit(
      key,
      resolved.limit,
      resolved.windowMs,
    );

    res.setHeader("X-RateLimit-Limit", resolved.limit);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());
    res.setHeader(
      "X-RateLimit-Policy",
      `${resolved.limit};w=${Math.ceil(resolved.windowMs / 1000)}`,
    );

    if (!allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((resetTime - Date.now()) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));

      logHighSeverity("Endpoint rate limit exceeded", {
        endpoint,
        limit: resolved.limit,
        windowMs: resolved.windowMs,
        provider: resolved.provider,
        tier: resolved.tier,
        source: resolved.source,
        path: req.path,
        method: req.method,
      });

      return res.status(429).json({
        error: "Rate limit exceeded",
        message: `Rate limit exceeded for ${endpoint}`,
        endpoint,
        limit: resolved.limit,
        provider: resolved.provider,
        tier: resolved.tier,
        source: resolved.source,
        retryAfter: retryAfterSeconds,
      });
    }

    next();
  };
}

/**
 * Global rate limit middleware.
 * Applies a per-IP sliding-window limit to all requests as a safety net.
 */
export async function globalRateLimit(req: Request, res: Response, next: NextFunction) {
  const key = `ratelimit:global:${req.ip}`;
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.GLOBAL_LIMIT,
    RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS,
  );

  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.GLOBAL_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    const retryAfterSeconds = Math.ceil((resetTime - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));

    logHighSeverity("Global rate limit exceeded", {
      ip: req.ip,
      limit: RATE_LIMIT_CONFIG.GLOBAL_LIMIT,
      window: "1 minute",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Too Many Requests",
      message: "Global rate limit exceeded. Try again shortly.",
      retryAfter: retryAfterSeconds,
    });
  }

  next();
}

/**
 * Middleware: for sep24Routes (Deposit/Withdrawal)
 * Limit: 10 requests per minute per user
 */
export const sep24RateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "SEP24");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.SEP24_LIMIT,
    RATE_LIMIT_CONFIG.SEP24_WINDOW_MS,
  );

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.SEP24_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    const retryAfterSeconds = Math.ceil((resetTime - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));

    logHighSeverity("SEP-24 rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.SEP24_LIMIT,
      window: "1 minute",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Rate limit exceeded for SEP-24 operations",
      retryAfter: retryAfterSeconds,
    });
  }

  next();
};

interface SlidingRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetTime: number;
}

async function checkSlidingWindowRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<SlidingRateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const expireSeconds = Math.ceil(windowMs / 1000) + 60;
  const member = `${now}:${Math.random().toString(36).slice(2, 12)}`;

  if (!redisClient.isOpen) {
    return {
      allowed: true,
      remaining: limit,
      retryAfterSeconds: 0,
      resetTime: now + windowMs,
    };
  }

  const script = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowStart = tonumber(ARGV[2])
    local maxRequests = tonumber(ARGV[3])
    local member = ARGV[4]
    local expireSeconds = tonumber(ARGV[5])

    redis.call("ZREMRANGEBYSCORE", key, 0, windowStart)
    local count = redis.call("ZCARD", key)

    if count >= maxRequests then
      local oldest = 0
      if count > 0 then
        local oldestRow = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
        oldest = tonumber(oldestRow[2]) or 0
      end
      if oldest > 0 then
        redis.call("EXPIRE", key, expireSeconds)
      end
      return {0, count, oldest}
    end

    redis.call("ZADD", key, now, member)
    count = count + 1
    local oldestRow = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
    local oldest = tonumber(oldestRow[2]) or now
    redis.call("EXPIRE", key, expireSeconds)
    return {1, count, oldest}
  `;

  try {
    const result = (await redisClient.sendCommand([
      "EVAL",
      script,
      "1",
      key,
      String(now),
      String(windowStart),
      String(limit),
      member,
      String(expireSeconds),
    ])) as unknown as [string | number, string | number, string | number];

    const allowed = String(result[0]) === "1";
    const count = Number(result[1]);
    const oldestScore = Number(result[2] || now);
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((oldestScore + windowMs - now) / 1000));
    const resetTime = oldestScore > 0 ? oldestScore + windowMs : now + windowMs;

    return {
      allowed,
      remaining: allowed ? Math.max(0, limit - count) : 0,
      retryAfterSeconds,
      resetTime,
    };
  } catch (error) {
    console.error("Cancellation rate limit Redis error:", error);
    return {
      allowed: true,
      remaining: limit,
      retryAfterSeconds: 0,
      resetTime: now + windowMs,
    };
  }
}

export const cancelTransactionRateLimiter = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = req.jwtUser?.userId;

  if (!userId) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Valid token required",
    });
  }

  const key = `cancellation:events:${userId}`;
  const {
    allowed,
    remaining,
    retryAfterSeconds,
    resetTime,
  } = await checkSlidingWindowRateLimit(
    key,
    RATE_LIMIT_CONFIG.CANCELLATION_LIMIT,
    RATE_LIMIT_CONFIG.CANCELLATION_WINDOW_MS,
  );

  res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_CONFIG.CANCELLATION_LIMIT));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      error: "Too Many Requests",
      message: `Too many transaction cancellation requests. Try again in ${retryAfterSeconds} seconds.`,
    });
  }

  next();
};

/**
 * Middleware: for sep31RateLimiter (Send Payment)
 * Limit: 5 requests per minute per user
 */
export const sep31RateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "SEP31");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.SEP31_LIMIT,
    RATE_LIMIT_CONFIG.SEP31_WINDOW_MS,
  );

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.SEP31_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    const retryAfterSeconds = Math.ceil((resetTime - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));

    logHighSeverity("SEP-31 rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.SEP31_LIMIT,
      window: "1 minute",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Rate limit exceeded for SEP-31 operations",
      retryAfter: retryAfterSeconds,
    });
  }

  next();
};

/**
 * Middleware: for sep12RateLimiter (KYC)
 * Limit: 20 requests per hour per user
 */
export const sep12RateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "SEP12");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.SEP12_LIMIT,
    RATE_LIMIT_CONFIG.SEP12_WINDOW_MS,
  );

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.SEP12_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    const retryAfterSeconds = Math.ceil((resetTime - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));

    logHighSeverity("SEP-12 rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.SEP12_LIMIT,
      window: "1 hour",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Rate limit exceeded for SEP-12 operations",
      retryAfter: retryAfterSeconds,
    });
  }

  next();
};


/**
 * Middleware: Rate limit for export endpoints
 * Limit: 5 exports per hour per admin
 */
export const rateLimitExport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "EXPORT");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.EXPORT_LIMIT,
    RATE_LIMIT_CONFIG.EXPORT_WINDOW_MS,
  );

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.EXPORT_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    const retryAfterSeconds = Math.ceil((resetTime - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));

    logHighSeverity("Export rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.EXPORT_LIMIT,
      window: "1 hour",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      message: "Rate limit exceeded for exports",
      error: "TOO_MANY_EXPORT_REQUESTS",
      retryAfter: retryAfterSeconds,
      resetTime: new Date(resetTime).toISOString(),
    });
  }

  next();
};

/**
 * Middleware: Intelligent rate limiting for list queries
 * Detects and limits massive data requests
 */
export const rateLimitListQueries = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = (req as any).user?.id;
  const limit = Number(req.query.limit) || 10;
  const page = Number(req.query.page) || 1;

  // Check if this is a massive list query (requesting more than threshold items)
  if (limit > RATE_LIMIT_CONFIG.MASSIVE_LIST_THRESHOLD) {
    logHighSeverity("Massive list query detected", {
      userId,
      requestedLimit: limit,
      threshold: RATE_LIMIT_CONFIG.MASSIVE_LIST_THRESHOLD,
      path: req.path,
      page,
      timestamp: new Date().toISOString(),
    });

    return res.status(400).json({
      message: "List query limit exceeded",
      error: "LIST_LIMIT_TOO_HIGH",
      maxAllowed: RATE_LIMIT_CONFIG.MASSIVE_LIST_THRESHOLD,
      currentRequest: limit,
    });
  }

  // Warn about suspicious queries (high limits without pagination awareness)
  if (limit > RATE_LIMIT_CONFIG.SUSPICIOUS_QUERY_THRESHOLD && page === 1) {
    console.warn("[RATE_LIMIT_WARNING] Suspicious list query", {
      userId,
      requestedLimit: limit,
      threshold: RATE_LIMIT_CONFIG.SUSPICIOUS_QUERY_THRESHOLD,
      path: req.path,
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

/**
 * Middleware: for assetIssuanceRateLimiter (#571)
 * Limit: 10 write operations per hour per admin
 *
 * Applied to the asset issuance workflow's mutating routes: creating a request,
 * submitting it, approving or rejecting it, and configuring a trustline. Reads
 * are left alone — a list endpoint is not worth a budget, and rate limiting
 * reads here would break the approval queue for no security benefit.
 */
export const assetIssuanceRateLimiter = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // `req.jwtUser` is what `requireAuth` actually sets; `req.user` is checked as
  // a fallback for any mount point that populates it instead. Reading only
  // `req.user` would rate limit nothing here, because it is never populated in
  // the normal auth path.
  const userId = req.jwtUser?.userId || (req as any).user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const key = generateRateLimitKey(userId, "ASSET_ISSUANCE");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.ASSET_ISSUANCE_LIMIT,
    RATE_LIMIT_CONFIG.ASSET_ISSUANCE_WINDOW_MS,
  );

  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.ASSET_ISSUANCE_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    const retryAfterSeconds = Math.ceil((resetTime - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));

    logHighSeverity("Asset issuance rate limit exceeded", {
      userId,
      limit: RATE_LIMIT_CONFIG.ASSET_ISSUANCE_LIMIT,
      window: "1 hour",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Rate limit exceeded for asset issuance operations",
      retryAfter: retryAfterSeconds,
    });
  }

  next();
};

/**
 * Middleware: for sep30RecoveryRateLimiter (#572)
 * Limit: 5 recovery operations per 15 minutes
 *
 * Keyed on the managed key rather than the user, because the thing being
 * protected is the key. A caller who rotates their identity is still working
 * against the same key, and a per-user limit would let a single recovery be
 * attacked from several accounts.
 *
 * Unlike `sep24RateLimiter` and friends, a caller with no authenticated identity
 * is *not* rejected with 401 here. The key id is still rate limited, so an
 * anonymous flood is bounded, and rejecting anonymous callers outright would
 * turn a rate limiter into an authentication check — which is the wrong tool and
 * would change the response code for a case that is already handled downstream.
 */
export const sep30RecoveryRateLimiter = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Prefer the authenticated user so one operator cannot exhaust another
  // operator's budget, and fall back to the key id when there is no user.
  const subject =
    req.jwtUser?.userId ||
    (req as any).user?.id ||
    req.params?.keyId ||
    req.ip ||
    "unknown";

  const key = generateRateLimitKey(`sep30-recovery:${subject}`, "SEP30_RECOVERY");
  const { allowed, remaining, resetTime } = await checkRateLimit(
    key,
    RATE_LIMIT_CONFIG.RECOVERY_LIMIT,
    RATE_LIMIT_CONFIG.RECOVERY_WINDOW_MS,
  );

  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_CONFIG.RECOVERY_LIMIT);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", new Date(resetTime).toISOString());

  if (!allowed) {
    const retryAfterSeconds = Math.ceil((resetTime - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));

    logHighSeverity("SEP-30 recovery rate limit exceeded", {
      subject,
      limit: RATE_LIMIT_CONFIG.RECOVERY_LIMIT,
      window: "15 minutes",
      path: req.path,
      method: req.method,
    });

    return res.status(429).json({
      error: "Rate limit exceeded for key recovery operations",
      retryAfter: retryAfterSeconds,
    });
  }

  next();
};

/**
 * Middleware: Combined rate limiting for sensitive admin operations
 * Applies both export and list query limits
 */
export const rateLimitAdminOperations = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // First apply list query limits
  rateLimitListQueries(req, res, (err) => {
    if (err) return; // Response already sent

    // Then pass to next middleware or route handler
    next();
  });
};

/**
 * Middleware: Cleanup expired rate limit entries
 * Call periodically to prevent memory leaks
 */
export const cleanupRateLimitStore = () => {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(
      `[RATE_LIMIT_CLEANUP] Cleaned up ${cleaned} expired rate limit entries`,
    );
  }
};

// Cleanup expired entries every 30 minutes
setInterval(cleanupRateLimitStore, 30 * 60 * 1000);

/**
 * Fix: Default export corrected to use globalRateLimit instead of
 * rateLimitAdminOperations. The global middleware registered via
 * `app.use(rateLimitDefaultMiddleware)` in src/index.ts is intended as a
 * safety-net for ALL incoming requests, enforcing RATE_LIMIT_CONFIG.GLOBAL_LIMIT
 * (200 req/min per IP) with RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS (60 000 ms).
 * Previously, rateLimitAdminOperations was exported as default, which only
 * applied list-query checks and did not enforce the global window limit,
 * leaving the application without effective global rate limiting.
 */
export default globalRateLimit;
