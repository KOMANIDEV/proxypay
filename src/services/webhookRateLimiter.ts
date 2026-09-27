/**
 * Webhook Rate Limiter
 * Implements per-merchant rate limiting with adaptive backoff based on delivery failures.
 */
import { redisClient } from '../config/redis';

export interface RateLimitConfig {
  /** Max deliveries per window */
  maxDeliveries: number;
  /** Window size in seconds */
  windowSecs: number;
  /** Max consecutive failures before reducing rate */
  failureThreshold: number;
  /** Reduced rate multiplier (0-1) applied when failure threshold exceeded */
  adaptiveMultiplier: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxDeliveries: 100,
  windowSecs: 60,
  failureThreshold: 5,
  adaptiveMultiplier: 0.5,
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterSecs?: number;
  isAdaptive: boolean;
}

/**
 * Check and record a webhook delivery attempt for a given merchant.
 * Uses Redis sliding window counter + failure tracking.
 */
export async function checkWebhookRateLimit(
  merchantId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
  redisImpl: typeof redisClient = redisClient,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - config.windowSecs;
  const counterKey = `webhook:ratelimit:${merchantId}`;
  const failureKey = `webhook:failures:${merchantId}`;

  // Check if Redis is available
  if (!redisImpl || !(redisImpl as any).isOpen) {
    // Fail open: allow delivery if Redis is unavailable
    return { allowed: true, remaining: config.maxDeliveries, resetAt: new Date((now + config.windowSecs) * 1000), isAdaptive: false };
  }

  try {
    // Get consecutive failure count for adaptive limiting
    const failureCountRaw = await (redisImpl as any).get(failureKey);
    const failureCount = failureCountRaw ? parseInt(failureCountRaw, 10) : 0;
    const isAdaptive = failureCount >= config.failureThreshold;
    const effectiveMax = isAdaptive
      ? Math.max(1, Math.floor(config.maxDeliveries * config.adaptiveMultiplier))
      : config.maxDeliveries;

    // Use a sorted set for sliding window
    // Remove old entries outside window
    await (redisImpl as any).zRemRangeByScore(counterKey, '-inf', windowStart);

    // Count current deliveries in window
    const current = await (redisImpl as any).zCard(counterKey);

    const resetAt = new Date((now + config.windowSecs) * 1000);

    if (current >= effectiveMax) {
      // Get the oldest entry to calculate retry-after
      const oldest = await (redisImpl as any).zRange(counterKey, 0, 0, { withScores: true });
      const oldestTs = oldest && oldest.length >= 2 ? parseFloat(oldest[1]) : now - config.windowSecs;
      const retryAfterSecs = Math.max(1, Math.ceil(oldestTs + config.windowSecs - now));

      return { allowed: false, remaining: 0, resetAt, retryAfterSecs, isAdaptive };
    }

    // Add current attempt to sliding window
    await (redisImpl as any).zAdd(counterKey, { score: now, value: `${now}-${Math.random()}` });
    // Expire the key after window + buffer
    await (redisImpl as any).expire(counterKey, config.windowSecs + 10);

    return { allowed: true, remaining: effectiveMax - current - 1, resetAt, isAdaptive };
  } catch (err) {
    console.warn('[WebhookRateLimiter] Redis error, failing open:', err);
    return { allowed: true, remaining: config.maxDeliveries, resetAt: new Date((now + config.windowSecs) * 1000), isAdaptive: false };
  }
}

/**
 * Record a delivery failure for adaptive rate limiting.
 */
export async function recordWebhookFailure(
  merchantId: string,
  redisImpl: typeof redisClient = redisClient,
): Promise<void> {
  if (!redisImpl || !(redisImpl as any).isOpen) return;
  try {
    const failureKey = `webhook:failures:${merchantId}`;
    await (redisImpl as any).incr(failureKey);
    await (redisImpl as any).expire(failureKey, 3600); // reset after 1 hour
  } catch (err) {
    console.warn('[WebhookRateLimiter] Failed to record failure:', err);
  }
}

/**
 * Record a delivery success (resets adaptive penalty).
 */
export async function recordWebhookSuccess(
  merchantId: string,
  redisImpl: typeof redisClient = redisClient,
): Promise<void> {
  if (!redisImpl || !(redisImpl as any).isOpen) return;
  try {
    const failureKey = `webhook:failures:${merchantId}`;
    await (redisImpl as any).del(failureKey);
  } catch (err) {
    console.warn('[WebhookRateLimiter] Failed to record success:', err);
  }
}

/**
 * Get delivery status/dashboard data for a merchant.
 */
export async function getWebhookDeliveryStatus(
  merchantId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
  redisImpl: typeof redisClient = redisClient,
): Promise<{ deliveriesInWindow: number; failureCount: number; isAdaptive: boolean; effectiveLimit: number }> {
  if (!redisImpl || !(redisImpl as any).isOpen) {
    return { deliveriesInWindow: 0, failureCount: 0, isAdaptive: false, effectiveLimit: config.maxDeliveries };
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - config.windowSecs;
    const counterKey = `webhook:ratelimit:${merchantId}`;
    const failureKey = `webhook:failures:${merchantId}`;

    await (redisImpl as any).zRemRangeByScore(counterKey, '-inf', windowStart);
    const deliveriesInWindow = await (redisImpl as any).zCard(counterKey);
    const failureCountRaw = await (redisImpl as any).get(failureKey);
    const failureCount = failureCountRaw ? parseInt(failureCountRaw, 10) : 0;
    const isAdaptive = failureCount >= config.failureThreshold;
    const effectiveLimit = isAdaptive
      ? Math.max(1, Math.floor(config.maxDeliveries * config.adaptiveMultiplier))
      : config.maxDeliveries;

    return { deliveriesInWindow, failureCount, isAdaptive, effectiveLimit };
  } catch {
    return { deliveriesInWindow: 0, failureCount: 0, isAdaptive: false, effectiveLimit: config.maxDeliveries };
  }
}
