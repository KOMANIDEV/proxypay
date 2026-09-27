/**
 * Adaptive Rate Limiter for Provider API Calls
 *
 * Uses a token bucket algorithm with adaptive adjustment based on:
 * - Provider rate limit headers (X-RateLimit-Remaining, Retry-After)
 * - HTTP 429 responses from providers
 * - Exponential backoff when limits are approached
 *
 * Configuration (env vars)
 * ------------------------
 * ADAPTIVE_RATE_LIMIT_ENABLED        – enable/disable adaptive throttling (default: true)
 * ADAPTIVE_RATE_LIMIT_DEFAULT_RPS    – default requests per second (default: 10)
 * ADAPTIVE_RATE_LIMIT_MIN_RPS        – minimum requests per second floor (default: 1)
 * ADAPTIVE_RATE_LIMIT_MAX_RPS        – maximum requests per second ceiling (default: 100)
 * ADAPTIVE_RATE_LIMIT_BACKOFF_FACTOR – multiplier on backoff (default: 0.5)
 * ADAPTIVE_RATE_LIMIT_RECOVERY_FACTOR – multiplier on recovery (default: 1.1)
 */

import { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";
import {
  adaptiveRateLimitAdjustmentsTotal,
  adaptiveRateLimitCurrentCapacity,
  rateLimitViolationsTotal,
} from "../utils/metrics";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AdaptiveRateLimitConfig {
  /** Default requests per second for this provider. */
  defaultRps: number;
  /** Minimum RPS floor – prevents throttling below this level. */
  minRps: number;
  /** Maximum RPS ceiling. */
  maxRps: number;
  /** Factor to multiply RPS on backoff (0-1). */
  backoffFactor: number;
  /** Factor to multiply RPS on recovery (>1). */
  recoveryFactor: number;
  /** Provider identifier for per-provider tracking. */
  provider: string;
}

export interface ProviderRateLimitState {
  currentRps: number;
  lastAdjustment: number;
  consecutiveFailures: number;
  lastFailureTime: number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

function loadDefaultConfig(): Omit<AdaptiveRateLimitConfig, "provider"> {
  return {
    defaultRps: parseInt(process.env.ADAPTIVE_RATE_LIMIT_DEFAULT_RPS ?? "10", 10),
    minRps: parseInt(process.env.ADAPTIVE_RATE_LIMIT_MIN_RPS ?? "1", 10),
    maxRps: parseInt(process.env.ADAPTIVE_RATE_LIMIT_MAX_RPS ?? "100", 10),
    backoffFactor: parseFloat(process.env.ADAPTIVE_RATE_LIMIT_BACKOFF_FACTOR ?? "0.5"),
    recoveryFactor: parseFloat(process.env.ADAPTIVE_RATE_LIMIT_RECOVERY_FACTOR ?? "1.1"),
  };
}

// ── Redis state management ────────────────────────────────────────────────────

const REDIS_KEY_PREFIX = "adaptive_rl:";

async function getState(
  provider: string,
): Promise<ProviderRateLimitState | null> {
  try {
    const data = await redisClient.hGetAll(`${REDIS_KEY_PREFIX}${provider}`);
    if (!data.currentRps) return null;
    return {
      currentRps: parseFloat(data.currentRps),
      lastAdjustment: parseInt(data.lastAdjustment, 10),
      consecutiveFailures: parseInt(data.consecutiveFailures, 10) || 0,
      lastFailureTime: parseInt(data.lastFailureTime, 10) || 0,
    };
  } catch {
    return null;
  }
}

async function setState(
  provider: string,
  state: ProviderRateLimitState,
): Promise<void> {
  try {
    await redisClient.hSet(`${REDIS_KEY_PREFIX}${provider}`, {
      currentRps: String(state.currentRps),
      lastAdjustment: String(state.lastAdjustment),
      consecutiveFailures: String(state.consecutiveFailures),
      lastFailureTime: String(state.lastFailureTime),
    });
    await redisClient.expire(`${REDIS_KEY_PREFIX}${provider}`, 3600);
  } catch {
    // Redis failure – state won't persist, but we can still operate in-memory
  }
}

// ── In-memory fallback ────────────────────────────────────────────────────────

const inMemoryState = new Map<string, ProviderRateLimitState>();

function getInMemoryState(
  provider: string,
  defaultRps: number,
): ProviderRateLimitState {
  const existing = inMemoryState.get(provider);
  if (existing) return existing;
  const state: ProviderRateLimitState = {
    currentRps: defaultRps,
    lastAdjustment: Date.now(),
    consecutiveFailures: 0,
    lastFailureTime: 0,
  };
  inMemoryState.set(provider, state);
  return state;
}

// ── Adaptive adjustment ───────────────────────────────────────────────────────

/**
 * Decrease the rate limit (backoff) when a rate limit violation is detected.
 */
export async function backoff(
  provider: string,
  config: AdaptiveRateLimitConfig,
): Promise<number> {
  const baseConfig = loadDefaultConfig();
  const cfg = { ...baseConfig, ...config };

  let state = await getState(provider);
  if (!state) {
    state = getInMemoryState(provider, cfg.defaultRps);
  }

  const newRps = Math.max(cfg.minRps, state.currentRps * cfg.backoffFactor);

  state.currentRps = newRps;
  state.consecutiveFailures += 1;
  state.lastFailureTime = Date.now();
  state.lastAdjustment = Date.now();

  await setState(provider, state);
  inMemoryState.set(provider, state);

  adaptiveRateLimitAdjustmentsTotal.inc({ provider, direction: "backoff" });
  adaptiveRateLimitCurrentCapacity.set({ provider }, newRps);

  console.warn(
    `[adaptive-rate-limit] Backoff: ${provider} RPS reduced to ${newRps.toFixed(2)} ` +
      `(consecutive failures: ${state.consecutiveFailures})`,
  );

  return newRps;
}

/**
 * Increase the rate limit (recovery) when the provider responds normally.
 */
export async function recover(
  provider: string,
  config: AdaptiveRateLimitConfig,
): Promise<number> {
  const baseConfig = loadDefaultConfig();
  const cfg = { ...baseConfig, ...config };

  let state = await getState(provider);
  if (!state) {
    state = getInMemoryState(provider, cfg.defaultRps);
  }

  const newRps = Math.min(cfg.maxRps, state.currentRps * cfg.recoveryFactor);

  state.currentRps = newRps;
  state.consecutiveFailures = 0;
  state.lastAdjustment = Date.now();

  await setState(provider, state);
  inMemoryState.set(provider, state);

  adaptiveRateLimitAdjustmentsTotal.inc({ provider, direction: "recovery" });
  adaptiveRateLimitCurrentCapacity.set({ provider }, newRps);

  return newRps;
}

/**
 * Get the current adaptive rate limit for a provider.
 */
export async function getCurrentRps(
  provider: string,
  defaultRps?: number,
): Promise<number> {
  const state = await getState(provider);
  if (state) return state.currentRps;

  // Fall back to in-memory
  const memState = inMemoryState.get(provider);
  return memState?.currentRps ?? defaultRps ?? loadDefaultConfig().defaultRps;
}

// ── Provider response analysis ────────────────────────────────────────────────

/**
 * Analyze provider response headers and adjust rate limits accordingly.
 * Call this after each provider API request.
 */
export async function recordProviderResponse(
  provider: string,
  statusCode: number,
  headers: Record<string, string | undefined>,
  config: AdaptiveRateLimitConfig,
): Promise<void> {
  const baseConfig = loadDefaultConfig();
  const cfg = { ...baseConfig, ...config };

  if (statusCode === 429) {
    // Rate limit violation detected
    rateLimitViolationsTotal.inc({ provider, status_code: "429" });
    await backoff(provider, cfg);

    // Parse Retry-After header for more aggressive backoff
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const retrySeconds = parseInt(retryAfter, 10);
      if (!isNaN(retrySeconds) && retrySeconds > 0) {
        // Calculate a safe RPS based on the retry-after hint
        const safeRps = Math.max(cfg.minRps, cfg.defaultRps / (retrySeconds + 1));
        const state = await getState(provider);
        if (state) {
          state.currentRps = safeRps;
          state.lastAdjustment = Date.now();
          await setState(provider, state);
          inMemoryState.set(provider, state);
          adaptiveRateLimitCurrentCapacity.set({ provider }, safeRps);
        }
      }
    }
    return;
  }

  if (statusCode >= 500) {
    // Server error – treat as potential rate limiting
    rateLimitViolationsTotal.inc({
      provider,
      status_code: String(statusCode),
    });
    await backoff(provider, cfg);
    return;
  }

  // Check X-RateLimit-Remaining header for proactive throttling
  const remaining = headers["x-ratelimit-remaining"];
  if (remaining !== undefined) {
    const remainingCount = parseInt(remaining, 10);
    if (!isNaN(remainingCount) && remainingCount <= 2) {
      // Very close to limit – back off
      await backoff(provider, cfg);
      return;
    }
  }

  // Success – attempt recovery
  if (statusCode >= 200 && statusCode < 300) {
    const state = await getState(provider);
    if (state && state.consecutiveFailures === 0 && state.currentRps < cfg.maxRps) {
      await recover(provider, cfg);
    }
  }
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * Express middleware that enforces adaptive rate limiting per provider.
 * Attach to provider-specific API routes.
 */
export function createAdaptiveRateLimitMiddleware(
  provider: string,
  overrides: Partial<AdaptiveRateLimitConfig> = {},
) {
  const baseConfig = loadDefaultConfig();
  const config: AdaptiveRateLimitConfig = {
    ...baseConfig,
    ...overrides,
    provider,
  };

  // Token bucket state per provider
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();

  return async function adaptiveRateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = `adaptive:${provider}`;
    const now = Date.now();

    // Get current RPS (may be adjusted by provider feedback)
    const currentRps = await getCurrentRps(provider, config.defaultRps);

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: currentRps, lastRefill: now };
      buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(currentRps, bucket.tokens + elapsedSec * currentRps);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - bucket.tokens) / currentRps) * 1000);
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      res.setHeader("X-RateLimit-Limit", Math.ceil(currentRps));
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("Retry-After", retryAfterSec);

      res.status(429).json({
        error: "Too Many Requests",
        message: `Rate limit exceeded for ${provider}. Retry after ${retryAfterSec}s.`,
        retryAfter: retryAfterSec,
      });
      return;
    }

    bucket.tokens -= 1;

    res.setHeader("X-RateLimit-Limit", Math.ceil(currentRps));
    res.setHeader("X-RateLimit-Remaining", Math.floor(bucket.tokens));

    next();
  };
}
