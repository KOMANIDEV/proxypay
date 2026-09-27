/**
 * Deprecation Middleware — Issue #245
 *
 * Implements RFC 8594 (Sunset) and RFC 9110 (Deprecation) response headers for
 * deprecated API endpoints, guiding clients to migrate to newer versions.
 *
 * Usage:
 *   import { deprecate, DeprecationRegistry } from '../middleware/deprecation';
 *
 *   // Register a deprecated route
 *   DeprecationRegistry.register({
 *     path: '/api/transactions',
 *     method: 'GET',
 *     deprecatedSince: '2025-01-01',
 *     sunsetDate: new Date('2026-12-31'),
 *     replacement: '/api/v2/transactions',
 *     reason: 'Replaced by v2 which supports pagination via cursor.',
 *   });
 *
 *   // Apply per-route (takes precedence over registry lookup):
 *   router.get('/old-endpoint', deprecate({ replacement: '/new-endpoint', sunsetDate: new Date('2026-12-31') }), handler);
 *
 *   // Or mount globally to auto-annotate any registered route:
 *   app.use(deprecationMiddleware);
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import logger from '../utils/logger';
import { deprecatedEndpointRequestsTotal, register } from '../utils/metrics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeprecationEntry {
  /** URL path pattern (e.g. '/api/transactions'). Simple string or regex. */
  path: string | RegExp;
  /** HTTP method to match, e.g. 'GET'. Omit to match all methods. */
  method?: string;
  /** ISO-8601 date string indicating when deprecation was first announced. */
  deprecatedSince?: string;
  /** Date after which the endpoint will be removed. */
  sunsetDate?: Date;
  /** Path or URL of the replacement endpoint. */
  replacement?: string;
  /** Human-readable reason for deprecation. */
  reason?: string;
}

export interface DeprecationOptions {
  /** Date after which the endpoint will be removed. */
  sunsetDate?: Date;
  /** Path or URL of the replacement endpoint. */
  replacement?: string;
  /** ISO-8601 date string indicating when deprecation was first announced. */
  deprecatedSince?: string;
  /** Human-readable reason. Included in the Warning response header. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Central registry of deprecated endpoints.
 * Populate at application startup before routes are mounted.
 */
export class DeprecationRegistry {
  private static entries: DeprecationEntry[] = [];

  /** Add a deprecated endpoint entry. */
  static register(entry: DeprecationEntry): void {
    this.entries.push(entry);
  }

  /** Look up a matching entry for the given request. Returns undefined if not found. */
  static lookup(method: string, path: string): DeprecationEntry | undefined {
    return this.entries.find((entry) => {
      const methodMatch =
        !entry.method || entry.method.toUpperCase() === method.toUpperCase();

      const pathMatch =
        entry.path instanceof RegExp
          ? entry.path.test(path)
          : path.startsWith(entry.path as string) || path === entry.path;

      return methodMatch && pathMatch;
    });
  }

  /** Return a snapshot of all registered entries (useful for OpenAPI generation). */
  static getAll(): ReadonlyArray<DeprecationEntry> {
    return [...this.entries];
  }

  /** Clear all entries (useful for tests). */
  static clear(): void {
    this.entries = [];
  }

  /**
   * Return the full deprecation timeline for the admin dashboard.
   * Each entry is enriched with computed status (announced / sunset-passed)
   * and days remaining until the sunset date.
   */
  static getTimeline(): Array<{
    path: string;
    method: string;
    deprecatedSince: string | undefined;
    sunsetDate: string | undefined;
    replacement: string | undefined;
    reason: string | undefined;
    status: 'announced' | 'sunset-passed' | 'no-sunset';
    daysUntilSunset: number | null;
  }> {
    const now = Date.now();
    return this.entries.map((entry) => {
      const sunsetTime = entry.sunsetDate?.getTime();
      let status: 'announced' | 'sunset-passed' | 'no-sunset' = 'no-sunset';
      let daysUntilSunset: number | null = null;

      if (sunsetTime !== undefined) {
        status = sunsetTime <= now ? 'sunset-passed' : 'announced';
        daysUntilSunset = Math.ceil((sunsetTime - now) / 86_400_000);
      }

      return {
        path: entry.path instanceof RegExp ? entry.path.source : entry.path,
        method: entry.method ?? 'ALL',
        deprecatedSince: entry.deprecatedSince,
        sunsetDate: entry.sunsetDate?.toISOString().split('T')[0],
        replacement: entry.replacement,
        reason: entry.reason,
        status,
        daysUntilSunset,
      };
    });
  }

  /**
   * Aggregate current Prometheus usage counters for every registered endpoint.
   * Useful for the admin dashboard to see which deprecated endpoints are still
   * receiving traffic and how close they are to sunset.
   */
  static async getUsageStats(): Promise<
    Array<{
      path: string;
      method: string;
      replacement: string | undefined;
      sunsetDate: string | undefined;
      requests: number;
    }>
  > {
    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'deprecated_endpoint_requests_total');
    const values = counter?.values ?? [];

    return this.entries.map((entry) => {
      const path = entry.path instanceof RegExp ? entry.path.source : entry.path;
      const method = entry.method ?? 'ALL';
      const replacement = entry.replacement;
      // The counter is labelled with the request's concrete path, so aggregate
      // all series that share this deprecation's replacement route.
      const requests = values
        .filter((v) => v.labels?.replacement === (replacement ?? ''))
        .reduce((sum, v) => sum + (typeof v.value === 'number' ? v.value : 0), 0);

      return {
        path,
        method,
        replacement,
        sunsetDate: entry.sunsetDate?.toISOString().split('T')[0],
        requests,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Monitoring helper
// ---------------------------------------------------------------------------

/**
 * Records usage of a deprecated endpoint against the
 * `deprecated_endpoint_requests_total` Prometheus counter.
 *
 * The counter is labelled with the resolved method, the concrete request path,
 * the replacement target, and the sunset date so operators can identify which
 * deprecated surfaces are still hot.
 */
export function recordDeprecatedUsage(opts: {
  method: string;
  path: string;
  replacement?: string;
  sunset?: Date;
}): void {
  deprecatedEndpointRequestsTotal.inc({
    method: opts.method.toUpperCase(),
    route: opts.path,
    replacement: opts.replacement ?? '',
    sunset: opts.sunset?.toISOString().split('T')[0] ?? '',
  });
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * Applies RFC 8594 / RFC 9110 deprecation response headers.
 *
 * Headers set:
 *   Deprecation: true  (or ISO date if deprecatedSince is provided)
 *   Sunset:      <HTTP-date>       (when sunsetDate is provided)
 *   Link:        <replacement>; rel="successor-version"  (when replacement is provided)
 *   Warning:     299 - "<reason>"  (when reason is provided)
 */
export function applyDeprecationHeaders(
  res: Response,
  opts: DeprecationOptions,
): void {
  // RFC 9110 §3.3 — Deprecation header
  const deprecationValue =
    opts.deprecatedSince
      ? new Date(opts.deprecatedSince).toUTCString()
      : 'true';
  res.setHeader('Deprecation', deprecationValue);

  // RFC 8594 — Sunset header
  if (opts.sunsetDate) {
    res.setHeader('Sunset', opts.sunsetDate.toUTCString());
  }

  // Link header pointing to the replacement
  if (opts.replacement) {
    const linkHeader = `<${opts.replacement}>; rel="successor-version"`;
    // Append rather than overwrite existing Link headers
    const existing = res.getHeader('Link');
    if (existing) {
      res.setHeader('Link', `${existing}, ${linkHeader}`);
    } else {
      res.setHeader('Link', linkHeader);
    }
  }

  // Warning header (299 = Miscellaneous persistent warning)
  if (opts.reason) {
    res.setHeader('Warning', `299 - "${opts.reason.replace(/"/g, "'")}"`);
  }
}

// ---------------------------------------------------------------------------
// Per-route middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express middleware that stamps the response with deprecation
 * headers.  Use this directly on a route when you have a one-off deprecation.
 *
 * @example
 *   router.get('/old', deprecate({ replacement: '/new', sunsetDate: new Date('2026-12-31') }), handler);
 */
export function deprecate(opts: DeprecationOptions): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    applyDeprecationHeaders(res, opts);
    next();
  };
}

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

/**
 * Global Express middleware that checks every incoming request against the
 * DeprecationRegistry and automatically adds deprecation headers when a match
 * is found.
 *
 * Mount this AFTER route definitions so `req.path` is fully resolved, but
 * BEFORE the error handler.  Alternatively mount it before routes — the
 * headers are only written once per response.
 *
 * @example
 *   app.use(deprecationMiddleware);
 */
export const deprecationMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const entry = DeprecationRegistry.lookup(req.method, req.path);

  if (entry) {
    applyDeprecationHeaders(res, {
      sunsetDate: entry.sunsetDate,
      replacement: entry.replacement,
      deprecatedSince: entry.deprecatedSince,
      reason: entry.reason,
    });

    recordDeprecatedUsage({
      method: req.method,
      path: req.path,
      replacement: entry.replacement,
      sunset: entry.sunsetDate,
    });

    logger.warn({
      msg: 'Deprecated endpoint accessed',
      method: req.method,
      path: req.path,
      replacement: entry.replacement,
      sunset: entry.sunsetDate?.toISOString(),
    });
  }

  next();
};
