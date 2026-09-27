import { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Per-route timeout middleware (#359)
// ---------------------------------------------------------------------------

interface RouteTimeoutConfig {
  timeoutMs: number;
  message?: string;
}

const DEFAULT_API_TIMEOUT_MS = 5_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_TIMEOUT_MS = 60_000;

/**
 * Default timeout values for common route categories.
 * Import this config object to reference or override timeout defaults.
 *
 * @example
 * import { ROUTE_TIMEOUT_DEFAULTS } from './middleware/routeTimeout';
 * console.log(ROUTE_TIMEOUT_DEFAULTS.api); // 5000
 */
export const ROUTE_TIMEOUT_DEFAULTS: Readonly<Record<"api" | "upload" | "batch", number>> = {
  api: DEFAULT_API_TIMEOUT_MS,
  upload: DEFAULT_UPLOAD_TIMEOUT_MS,
  batch: DEFAULT_BATCH_TIMEOUT_MS,
} as const;

/**
 * Admin-managed timeout overrides (in-memory, mutable at runtime).
 * Keys are route patterns like "POST /transactions" or "*" for global.
 */
const routeTimeoutOverrides = new Map<string, number>();

export function setRouteTimeoutOverride(
  routePattern: string,
  timeoutMs: number,
): void {
  routeTimeoutOverrides.set(routePattern, timeoutMs);
}

export function getRouteTimeoutOverrides(): ReadonlyMap<string, number> {
  return routeTimeoutOverrides;
}

export function deleteRouteTimeoutOverride(routePattern: string): boolean {
  return routeTimeoutOverrides.delete(routePattern);
}

/**
 * Resolves the effective timeout for a given request by checking overrides,
 * then environment defaults, then built-in presets.
 */
function resolveTimeoutMs(
  req: Request,
  preset: "api" | "upload" | "batch",
): number {
  const method = req.method;
  const path = req.path || req.url;
  const key = `${method} ${path}`;

  const override = routeTimeoutOverrides.get(key) ?? routeTimeoutOverrides.get("*");
  if (override !== undefined) return override;

  if (process.env.REQUEST_TIMEOUT_MS) {
    return parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || DEFAULT_API_TIMEOUT_MS;
  }

  switch (preset) {
    case "upload":
      return DEFAULT_UPLOAD_TIMEOUT_MS;
    case "batch":
      return DEFAULT_BATCH_TIMEOUT_MS;
    default:
      return DEFAULT_API_TIMEOUT_MS;
  }
}

/**
 * Creates a per-route timeout middleware.
 *
 * @param preset - The default timeout category (api=5s, upload=30s, batch=60s)
 * @returns Express middleware that aborts the request after the resolved timeout
 *
 * @example
 * router.post('/upload', routeTimeout('upload'), handler);
 * router.get('/reports', routeTimeout('batch'), handler);
 */
export function routeTimeout(preset: "api" | "upload" | "batch" = "api") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timeoutMs = resolveTimeoutMs(req, preset);

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(408).json({
          error: "Request Timeout",
          message: `Request exceeded ${timeoutMs}ms limit`,
          code: "REQUEST_TIMEOUT",
          timeoutMs,
          route: `${req.method} ${req.path}`,
        });
      }
      req.destroy();
    }, timeoutMs);

    res.once("finish", () => clearTimeout(timer));
    res.once("close", () => clearTimeout(timer));

    next();
  };
}

/**
 * Admin endpoint handler: GET /admin/timeouts
 */
export function listTimeouts(_req: Request, res: Response): void {
  res.json({
    defaults: {
      api: DEFAULT_API_TIMEOUT_MS,
      upload: DEFAULT_UPLOAD_TIMEOUT_MS,
      batch: DEFAULT_BATCH_TIMEOUT_MS,
    },
    envOverride: process.env.REQUEST_TIMEOUT_MS
      ? parseInt(process.env.REQUEST_TIMEOUT_MS, 10)
      : null,
    routeOverrides: Object.fromEntries(routeTimeoutOverrides),
  });
}

/**
 * Admin endpoint handler: PUT /admin/timeouts
 * Body: { route: string, timeoutMs: number } | { route: string }
 */
export function updateTimeout(req: Request, res: Response): void {
  const { route, timeoutMs } = req.body as {
    route?: string;
    timeoutMs?: number;
  };

  if (!route) {
    res.status(400).json({ error: "Missing required field: route" });
    return;
  }

  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== "number" || timeoutMs < 1000 || timeoutMs > 300000) {
      res.status(400).json({
        error: "timeoutMs must be a number between 1000 and 300000",
      });
      return;
    }
    setRouteTimeoutOverride(route, timeoutMs);
  } else {
    deleteRouteTimeoutOverride(route);
  }

  res.json({
    message: "Timeout updated",
    route,
    timeoutMs: routeTimeoutOverrides.get(route) ?? null,
    overrides: Object.fromEntries(routeTimeoutOverrides),
  });
}
