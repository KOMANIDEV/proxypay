import { Request, Response, NextFunction } from "express";
import timeout from "connect-timeout";

/**
 * Timeout middleware configuration
 */
const DEFAULT_TIMEOUT = "30s";

/**
 * Gets the configured timeout value from environment or uses default
 */
export function getTimeoutValue(): string {
  const timeoutMs = process.env.REQUEST_TIMEOUT_MS;
  if (timeoutMs) {
    return `${timeoutMs}ms`;
  }
  return DEFAULT_TIMEOUT;
}

/**
 * Global timeout middleware
 * Applies default timeout to all requests
 */
export const globalTimeout = timeout(getTimeoutValue());

/**
 * Timeout handler middleware
 * Checks if request has timed out and returns 408 status
 */
export const haltOnTimedout = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!req.timedout) {
    next();
  }
};

/**
 * Timeout error handler
 * Logs timeout events and returns proper error response
 */
export const timeoutErrorHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.timedout) {
    console.warn("Request timeout:", {
      method: req.method,
      url: req.url,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });

    return res.status(408).json({
      error: "Request Timeout",
      message: "The request took too long to process",
      code: "REQUEST_TIMEOUT",
    });
  }
  next();
};

/**
 * Creates a custom timeout middleware for specific routes
 *
 * @param timeoutMs - Timeout in milliseconds
 * @returns Express middleware
 *
 * @example
 * router.post('/long-operation', customTimeout(60000), handler);
 */
export function customTimeout(timeoutMs: number) {
  return timeout(`${timeoutMs}ms`);
}

/**
 * Timeout configuration presets for common operations
 */
export const TimeoutPresets = {
  quick: customTimeout(5000), // 5 seconds - for simple queries
  medium: customTimeout(15000), // 15 seconds - for report generation
  standard: customTimeout(30000), // 30 seconds - default operations
  long: customTimeout(60000), // 60 seconds - complex transactions
  extended: customTimeout(120000), // 2 minutes - batch operations
};
