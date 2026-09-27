/**
 * Deprecation Registry Seed — Issue #393
 *
 * Populates the DeprecationRegistry with the API endpoints that are deprecated
 * but still served so clients can migrate before they are removed.
 *
 * The current set of deprecated endpoints are the **legacy unversioned** paths
 * that predate explicit versioning. They continue to work (and internally route
 * to the matching v1 handler) but are advertised as deprecated via the
 * `Deprecation`, `Sunset`, and `Link` response headers so clients migrate to
 * explicit `/api/v1/...` (or `/api/v2/...`) paths.
 *
 * Sunset dates are configurable via `DEPRECATION_SUNSET_DAYS` (default 210,
 * matching the documented "v1 sunset = GA + 210 days" policy).
 */

import { DeprecationRegistry, DeprecationEntry } from './deprecation';

const DEFAULT_SUNSET_DAYS = 210;

function sunsetDaysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

function envSunsetDays(): number {
  const raw = process.env.DEPRECATION_SUNSET_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUNSET_DAYS;
}

function buildEntry(
  path: string,
  method: string | undefined,
  replacement: string,
  reason: string,
): DeprecationEntry {
  return {
    path,
    method,
    deprecatedSince: new Date().toISOString().split('T')[0],
    sunsetDate: sunsetDaysFromNow(envSunsetDays()),
    replacement,
    reason,
  };
}

const LEGACY_DEPRECATED_ENDPOINTS: Array<{
  path: string;
  method: string | undefined;
  replacement: string;
  reason: string;
}> = [
  {
    path: '/api/transactions',
    method: undefined,
    replacement: '/api/v1/transactions',
    reason: 'Legacy unversioned endpoint. Pin the version explicitly (e.g. /api/v1/transactions).',
  },
  {
    path: '/api/disputes',
    method: undefined,
    replacement: '/api/v1/disputes',
    reason: 'Legacy unversioned endpoint. Use /api/v1/disputes.',
  },
  {
    path: '/api/stats',
    method: undefined,
    replacement: '/api/v1/stats',
    reason: 'Legacy unversioned endpoint. Use /api/v1/stats.',
  },
  {
    path: '/api/vaults',
    method: undefined,
    replacement: '/api/v1/vaults',
    reason: 'Legacy unversioned endpoint. Use /api/v1/vaults.',
  },
  {
    path: '/api/bulk',
    method: undefined,
    replacement: '/api/v1/transactions/bulk',
    reason: 'Legacy unversioned endpoint. Use /api/v1/transactions/bulk.',
  },
];

/**
 * Idempotently seed the DeprecationRegistry with the legacy deprecated
 * endpoints. Safe to call multiple times.
 */
export function seedDeprecations(): void {
  for (const entry of LEGACY_DEPRECATED_ENDPOINTS) {
    DeprecationRegistry.register(
      buildEntry(entry.path, entry.method, entry.replacement, entry.reason),
    );
  }
}
