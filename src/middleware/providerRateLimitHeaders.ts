/**
 * Provider Rate Limit Header Parsing
 *
 * Provider APIs communicate their rate limiting state via headers. Without
 * parsing these, the client cannot know how much quota remains or when it
 * resets, so throttling decisions are blind.
 *
 * This module:
 *   - Parses the X-RateLimit-* header family (Limit, Remaining, Reset,
 *     Policy, Retry-After) returned by provider APIs.
 *   - Tracks the remaining quota and reset time per provider (in-memory,
 *     with an optional Redis backing store).
 *   - Implements header-driven throttling so outbound provider requests can
 *     be gated before a hard 429 is returned.
 *   - Supports provider-specific header mappings, since each provider may
 *     name or format these headers differently.
 *
 * Header format reference (RFC 822 / common API-gateway convention):
 *   X-RateLimit-Limit     – maximum allowed requests in the current window
 *   X-RateLimit-Remaining – requests remaining in the current window
 *   X-RateLimit-Reset     – window reset (epoch seconds | delta seconds | HTTP-date)
 *   X-RateLimit-Policy    – optional window metadata (e.g. "60;w=60")
 *   Retry-After           – seconds (or HTTP-date) to wait before retrying
 */

import { redisClient } from "../config/redis";
import {
  providerRateLimitState,
  providerRateLimitHitsTotal,
} from "../utils/metrics";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderName = "mtn" | "airtel" | "orange" | "vodacom" | "tigo";

/**
 * A provider-specific mapping from the canonical header to the header names
 * (plus optional value transforms) that the provider actually sends.
 */
export interface ProviderRateLimitHeaderMap {
  /** Header carrying the request limit for the window (X-RateLimit-Limit). */
  limit?: string;
  /** Header carrying the remaining quota (X-RateLimit-Remaining). */
  remaining?: string;
  /**
   * Header carrying the reset time. The value may be an epoch timestamp,
   * a number of seconds until reset, or an HTTP-date. Parsed automatically.
   */
  reset?: string;
  /**
   * Header carrying the window policy (e.g. "60;w=60" or "10;w=1"). When the
   * reset is expressed as a duration, this can refine how it is interpreted.
   */
  policy?: string;
  /** Header carrying how long to wait before retrying (Retry-After). */
  retryAfter?: string;
}

export interface ProviderRateLimitConfig {
  /** Provider identifier used for state keys and metrics labels. */
  provider: ProviderName | string;
  /** Header names this provider uses. Defaults to the conventional names. */
  headers?: ProviderRateLimitHeaderMap;
  /**
   * Remaining-quota threshold (0-1 of the limit, or 0 if using an absolute
   * count) at which header-based throttling should start gating requests.
   * Range 0..1. Default 0.2 (i.e. throttle when <20% of quota remains).
   */
  lowQuotaRatio?: number;
  /**
   * When true (default), throttle requests when the remaining quota is at or
   * below `lowQuotaCount`. When false, only throttles when less than
   * `lowQuotaRatio` (fraction) of quota remains.
   */
  useAbsoluteCount?: boolean;
  /** Absolute remaining-count threshold when `useAbsoluteCount` is true. */
  lowQuotaCount?: number;
  /**
   * Number of milliseconds before the reset time at which the hard throttle
   * window is lifted early (lets a burst through just after the reset).
   */
  resetLeewayMs?: number;
}

/** Parsed quota snapshot from a provider response. */
export interface ProviderRateLimitQuota {
  /** Maximum requests allowed in the window. `null` when unknown. */
  limit: number | null;
  /** Requests remaining in the window. `null` when unknown. */
  remaining: number | null;
  /** Residue after integer rounding. Used for ratio-based throttling. */
  remainingRaw: number | null;
  /** Epoch ms when the window resets. `null` when unknown. */
  resetAt: number | null;
  /** Window length in seconds, when a policy is provided. `null` otherwise. */
  windowSeconds: number | null;
  /** Seconds to wait before retrying (from Retry-After). `null` otherwise. */
  retryAfterSeconds: number | null;
  /** True when any header value was recognised and successfully parsed. */
  parsed: boolean;
}

/** Persisted per-provider rate limit state used by the throttler. */
export interface ProviderRateLimitState {
  provider: string;
  remaining: number | null;
  limit: number | null;
  resetAt: number | null;
  updatedAt: number;
}

export interface ThrottleDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Suggested delay (ms) before the next request, from Retry-After. */
  retryAfterMs: number | null;
  /** Remaining quota after the decision. */
  remaining: number | null;
  /** Epoch ms of the window reset, if known. */
  resetAt: number | null;
  /** Reason for disallowing, when `allowed` is false. */
  reason?: "exhausted" | "low-quota" | "retry-after" | null;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Conventional header names used by most API providers. */
export const DEFAULT_HEADER_MAP: Required<ProviderRateLimitHeaderMap> = {
  limit: "x-ratelimit-limit",
  remaining: "x-ratelimit-remaining",
  reset: "x-ratelimit-reset",
  policy: "x-ratelimit-policy",
  retryAfter: "retry-after",
};

/**
 * Provider-specific header mappings. Each mobile money provider may use a
 * slightly different scheme, so headers are normalised per provider here.
 * Any provider without an explicit map falls back to DEFAULT_HEADER_MAP.
 */
export const PROVIDER_RATE_LIMIT_HEADER_MAPS: Record<
  string,
  ProviderRateLimitHeaderMap
> = {
  mtn: {},
  airtel: {},
  orange: {},
  vodacom: {},
  tigo: {},
};

const DEFAULT_LOW_QUOTA_RATIO = 0.2;
const DEFAULT_LOW_QUOTA_COUNT = 2;
const DEFAULT_RESET_LEEWAY_MS = 1000;

/** Redis key prefix for persisted quota state. */
const REDIS_KEY_PREFIX = "provider_rate_limit:";

// ── Header access ─────────────────────────────────────────────────────────────

/**
 * Normalise an inbound headers object. Provider libraries/axios may hand us
 * either lower-cased keys (node http) or original-case keys (Fetch API /
 * Headers). Both are folded to lower case and, when a header appears more
 * than once (e.g. round-robin gateways), only the last value is kept.
 */
export function normalizeHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (Array.isArray(value)) {
      if (value.length > 0) {
        normalized[lower] = String(value[value.length - 1]);
      }
    } else {
      normalized[lower] = String(value);
    }
  }
  return normalized;
}

/** Case-insensitively resolve a header name against normalised headers. */
export function getHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return headers[name.toLowerCase()];
}

// ── Value parsing ─────────────────────────────────────────────────────────────

/** Parse a non-negative integer header value. Returns null when invalid. */
export function parseCount(value: string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/** Parse an integer that may be negative (e.g. "-1" meaning none). */
function parseIntValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = String(value).trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/** Parse a reset value into an epoch-ms timestamp. Returns null when unknown. */
export function parseReset(value: string | undefined, now: number): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;

  // Epoch seconds (in the future, past the "already reset" baseline).
  if (/^\d{10}(\d{3})?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      // Distinguish epoch-seconds (10 digits) from epoch-milliseconds (13).
      const ms = trimmed.length === 13 ? num : num * 1000;
      return ms > 0 ? ms : null;
    }
  }

  // Delta seconds — a small integer of seconds until reset.
  if (/^\d+$/.test(trimmed) && trimmed.length <= 6) {
    const secs = Number(trimmed);
    // A 10-digit value is epoch-seconds and handled above; guard against
    // treating far-future epoch values as deltas.
    if (secs > 0) return now + secs * 1000;
  }

  // HTTP-date (RFC 1123 / RFC 850 / asctime).
  const parsedDate = new Date(trimmed).getTime();
  if (!Number.isNaN(parsedDate)) {
    return parsedDate > now ? parsedDate : null;
  }

  return null;
}

/** Parse seconds until reset when the reset header only carries a count. */
export function parseDeltaSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse a Retry-After value: either a number of seconds (positive integer)
 * or an HTTP-date.
 */
export function parseRetryAfter(
  value: string | undefined,
  now: number,
): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) && secs >= 0 ? secs : null;
  }

  const parsedDate = new Date(trimmed).getTime();
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, Math.ceil((parsedDate - now) / 1000));
  }

  return null;
}

/**
 * Parse a window policy header such as "60;w=60" or "20;w=1". Returns the
 * window length in seconds, or null when it cannot be determined.
 */
export function parseWindowSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;

  // "60;w=60" – the second half "w=60" is the window length.
  const match = /(?:^|[;,\s])w\s*=\s*(\d+)/i.exec(trimmed);
  if (match) {
    return Number(match[1]);
  }

  // "5;window=5" – "window=..." form.
  const windowMatch = /(?:^|[;,\s])window\s*=\s*(\d+)/i.exec(trimmed);
  if (windowMatch) {
    return Number(windowMatch[1]);
  }

  // Single integer — assume it IS the window length (seconds).
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  return null;
}

// ── Header map resolution ─────────────────────────────────────────────────────

/**
 * Resolve the effective header map for a provider, falling back to the
 * conventional names when a provider has not been configured.
 */
export function resolveHeaderMap(config: ProviderRateLimitConfig): Required<ProviderRateLimitHeaderMap> {
  const userOverrides = config.headers ?? {};
  const providerMap = PROVIDER_RATE_LIMIT_HEADER_MAPS[config.provider] ?? {};
  return {
    limit:
      userOverrides.limit ??
      providerMap.limit ??
      DEFAULT_HEADER_MAP.limit,
    remaining:
      userOverrides.remaining ??
      providerMap.remaining ??
      DEFAULT_HEADER_MAP.remaining,
    reset:
      userOverrides.reset ??
      providerMap.reset ??
      DEFAULT_HEADER_MAP.reset,
    policy:
      userOverrides.policy ??
      providerMap.policy ??
      DEFAULT_HEADER_MAP.policy,
    retryAfter:
      userOverrides.retryAfter ??
      providerMap.retryAfter ??
      DEFAULT_HEADER_MAP.retryAfter,
  };
}

// ── Quota parsing ─────────────────────────────────────────────────────────────

/**
 * Parse provider rate limit headers into a quota snapshot. This is the core
 * parsing routine and is exposed for testability and reuse.
 *
 * @param config Provider-specific config (header names, thresholds).
 * @param headers Raw response headers.
 * @param now Optional clock (epoch ms) for deterministic tests.
 */
export function parseProviderRateLimitHeaders(
  config: ProviderRateLimitConfig,
  headers: Record<string, string | string[] | number | undefined>,
  now: number = Date.now(),
): ProviderRateLimitQuota {
  const normalized = normalizeHeaders(headers);
  const map = resolveHeaderMap(config);

  const limit = parseCount(getHeader(normalized, map.limit));
  const remainingRaw = parseCount(getHeader(normalized, map.remaining));
  const remaining = remainingRaw === null ? null : Math.round(remainingRaw);

  const retryAfterSeconds = parseRetryAfter(
    getHeader(normalized, map.retryAfter),
    now,
  );

  const windowSeconds =
    parseWindowSeconds(getHeader(normalized, map.policy)) ??
    parseDeltaSeconds(getHeader(normalized, map.policy));

  let resetAt = parseReset(getHeader(normalized, map.reset), now);
  // If the reset is a delta but the delta is large (e.g. 3600s), parseReset
  // would have read it as a timestamp only if it was 10+ digits. For a plain
  // integer reset of up to 6 digits it is treated as delta already.
  if (resetAt === null && retryAfterSeconds !== null) {
    resetAt = now + retryAfterSeconds * 1000;
  }

  const parsed =
    limit !== null ||
    remaining !== null ||
    resetAt !== null ||
    retryAfterSeconds !== null ||
    windowSeconds !== null;

  return {
    limit,
    remaining,
    remainingRaw,
    resetAt,
    windowSeconds,
    retryAfterSeconds,
    parsed,
  };
}

// ── State persistence ─────────────────────────────────────────────────────────

const inMemoryState = new Map<string, ProviderRateLimitState>();

async function readState(provider: string): Promise<ProviderRateLimitState | null> {
  try {
    const data = await redisClient.hGetAll(`${REDIS_KEY_PREFIX}${provider}`);
    if (data.updatedAt) {
      return {
        provider,
        remaining: data.remaining !== undefined ? parseIntValue(data.remaining) : null,
        limit: data.limit !== undefined ? parseIntValue(data.limit) : null,
        resetAt: data.resetAt !== undefined ? parseIntValue(data.resetAt) : null,
        updatedAt: parseInt(data.updatedAt, 10),
      };
    }
  } catch {
    // Redis unavailable – fall through to in-memory state.
  }
  return inMemoryState.get(provider) ?? null;
}

async function writeState(state: ProviderRateLimitState): Promise<void> {
  inMemoryState.set(state.provider, state);
  try {
    await redisClient.hSet(`${REDIS_KEY_PREFIX}${state.provider}`, {
      remaining: state.remaining === null ? "" : String(state.remaining),
      limit: state.limit === null ? "" : String(state.limit),
      resetAt: state.resetAt === null ? "" : String(state.resetAt),
      updatedAt: String(state.updatedAt),
    });
    await redisClient.expire(`${REDIS_KEY_PREFIX}${state.provider}`, 3600);
  } catch {
    // Redis unavailable – in-memory state already updated.
  }
}

// ── State tracking ────────────────────────────────────────────────────────────

/**
 * Record a provider response so its quota is tracked. Call this after every
 * outbound provider request with the response headers. Returns the parsed
 * (and now persisted) quota snapshot.
 */
export async function trackProviderRateLimit(
  config: ProviderRateLimitConfig,
  headers: Record<string, string | string[] | number | undefined>,
  now: number = Date.now(),
): Promise<ProviderRateLimitQuota> {
  const quota = parseProviderRateLimitHeaders(config, headers, now);

  if (!quota.parsed) {
    return quota;
  }

  const state: ProviderRateLimitState = {
    provider: config.provider,
    remaining: quota.remaining,
    limit: quota.limit,
    resetAt: quota.resetAt,
    updatedAt: now,
  };

  await writeState(state);

  if (quota.remaining !== null) {
    providerRateLimitState.set(
      { provider: config.provider },
      quota.remaining,
    );
  }

  return quota;
}

/**
 * Read the last tracked quota for a provider without recording a new sample.
 */
export async function getProviderRateLimit(
  provider: ProviderName | string,
): Promise<ProviderRateLimitState | null> {
  return readState(provider);
}

// ── Header-based throttling ───────────────────────────────────────────────────

/**
 * Decide whether an outbound provider request may proceed based on the last
 * tracked quota plus (optionally) fresh headers from the most recent response.
 *
 * This implements header-driven throttling: instead of firing requests until
 * the provider answers with a hard 429, we gate before that point using the
 * remaining-quota/reset info the provider already announced.
 *
 * @param config Provider config (thresholds).
 * @param opts.lastQuota Previously tracked quota (from trackProviderRateLimit).
 * @param opts.headers Fresh response headers (optional) to re-parse.
 * @param opts.now Clock override for deterministic tests.
 */
export async function decideThrottle(
  config: ProviderRateLimitConfig,
  opts: {
    lastQuota?: ProviderRateLimitState | null;
    headers?: Record<string, string | string[] | number | undefined>;
    now?: number;
  } = {},
): Promise<ThrottleDecision> {
  const now = opts.now ?? Date.now();
  let state = opts.lastQuota ?? null;

  // Fresh headers take precedence over stale persisted state.
  if (opts.headers && opts.headers !== undefined) {
    const quota = parseProviderRateLimitHeaders(config, opts.headers, now);
    if (quota.parsed) {
      state = {
        provider: config.provider,
        remaining: quota.remaining,
        limit: quota.limit,
        resetAt: quota.resetAt,
        updatedAt: now,
      };
    }
  }

  if (state === null) {
    state = await readState(config.provider);
  }

  if (state === null) {
    // No quota information yet — allow the request.
    return { allowed: true, retryAfterMs: null, remaining: null, resetAt: null };
  }

  const resetAt = state.resetAt;
  const retryAfter = opts.headers
    ? parseRetryAfter(
        getHeader(
          normalizeHeaders(opts.headers),
          resolveHeaderMap(config).retryAfter,
        ),
        now,
      )
    : null;

  // 1. Positive Retry-After from the provider – throttle until it elapses.
  if (retryAfter !== null && retryAfter > 0) {
    const retryAfterMs = retryAfter * 1000;
    providerRateLimitHitsTotal.inc({ provider: config.provider, reason: "retry-after" });
    return {
      allowed: false,
      retryAfterMs,
      remaining: state.remaining,
      resetAt,
      reason: "retry-after",
    };
  }

  // 2. Quota exhausted or window reset while there is still an effective
  //    remaining count.
  if (state.remaining !== null && resetAt !== null) {
    const leeway = config.resetLeewayMs ?? DEFAULT_RESET_LEEWAY_MS;
    const nearReset = now >= resetAt - leeway;
    if (state.remaining <= 0 && !nearReset) {
      providerRateLimitHitsTotal.inc({ provider: config.provider, reason: "exhausted" });
      return {
        allowed: false,
        retryAfterMs: Math.max(0, resetAt - now),
        remaining: state.remaining,
        resetAt,
        reason: "exhausted",
      };
    }
  }

  // 3. Low remaining quota – throttle proactively.
  if (state.remaining !== null && state.limit !== null && state.limit > 0) {
    const useAbsolute =
      config.useAbsoluteCount ?? false;
    const lowCount = config.lowQuotaCount ?? DEFAULT_LOW_QUOTA_COUNT;
    const lowRatio = config.lowQuotaRatio ?? DEFAULT_LOW_QUOTA_RATIO;

    const isLow = useAbsolute
      ? state.remaining <= lowCount
      : state.remaining / state.limit <= lowRatio;

    const nearReset =
      resetAt !== null && now >= resetAt - (config.resetLeewayMs ?? DEFAULT_RESET_LEEWAY_MS);

    if (isLow && !nearReset) {
      const waitMs =
        resetAt !== null
          ? Math.max(0, resetAt - now)
          : (config.resetLeewayMs ?? DEFAULT_RESET_LEEWAY_MS);
      return {
        allowed: false,
        retryAfterMs: waitMs,
        remaining: state.remaining,
        resetAt,
        reason: "low-quota",
      };
    }
  }

  return {
    allowed: true,
    retryAfterMs: null,
    remaining: state.remaining,
    resetAt,
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Clear all in-memory quota state. Intended for tests. */
export function _resetProviderRateLimitState(): void {
  inMemoryState.clear();
}
