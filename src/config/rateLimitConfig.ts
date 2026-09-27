/**
 * Per-route-group sliding window rate limit configuration.
 *
 * Limits are expressed as { max } requests per { windowMs } milliseconds.
 * Each entry maps to a route group tag applied in the middleware factory.
 *
 * Values can be overridden per environment via the NODE_ENV-keyed overrides
 * object below.
 */

export type RouteGroup = "auth" | "payment" | "readonly";

export interface RateLimitEntry {
  /** Maximum requests allowed within the window. */
  max: number;
  /** Sliding window size in milliseconds. */
  windowMs: number;
}

export type RateLimitConfig = Record<RouteGroup, RateLimitEntry>;

const defaults: RateLimitConfig = {
  auth:     { max: 5,   windowMs: 60_000 },   // 5 req/min
  payment:  { max: 60,  windowMs: 60_000 },   // 60 req/min
  readonly: { max: 300, windowMs: 60_000 },   // 300 req/min
};

const overrides: Partial<Record<string, Partial<RateLimitConfig>>> = {
  test: {
    auth:     { max: 5,   windowMs: 60_000 },
    payment:  { max: 60,  windowMs: 60_000 },
    readonly: { max: 300, windowMs: 60_000 },
  },
  development: {
    auth:     { max: 50,   windowMs: 60_000 },
    payment:  { max: 600,  windowMs: 60_000 },
    readonly: { max: 3000, windowMs: 60_000 },
  },
};

function buildConfig(): RateLimitConfig {
  const env = process.env.NODE_ENV ?? "production";
  const envOverride = overrides[env] ?? {};
  return {
    auth:     { ...defaults.auth,     ...(envOverride.auth     ?? {}) },
    payment:  { ...defaults.payment,  ...(envOverride.payment  ?? {}) },
    readonly: { ...defaults.readonly, ...(envOverride.readonly ?? {}) },
  };
}

export const rateLimitConfig: RateLimitConfig = buildConfig();
