/**
 * #415 Mobile App API Versioning Strategy
 *
 * Provides:
 *  - API version selection by app version (X-App-Version header)
 *  - Feature flags per app version
 *  - Deprecation timeline with Sunset/Link headers
 *  - Backward compatibility layer for old versions
 */

import { Request, Response, RequestHandler } from 'express';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VersionedRequest extends Request {
  /** The resolved API version (e.g. "v1", "v2") */
  apiVersion?: string;
  /** The raw version string sent by the caller */
  requestedVersion?: string;
  /** Parsed app version from X-App-Version header */
  appVersion?: string;
  /** Feature flags active for the resolved API version */
  featureFlags?: Record<string, boolean>;
}

export interface DeprecationEntry {
  version: string;
  /** ISO-8601 date after which the version will be removed */
  sunsetDate: string;
  /** Link to migration docs */
  migrationUrl?: string;
}

// ---------------------------------------------------------------------------
// Version catalogue
// ---------------------------------------------------------------------------

/** The latest stable API version. */
export const CURRENT_VERSION = 'v1';

/** All versions the server accepts. */
export const SUPPORTED_VERSIONS: string[] = ['v1', 'v2'];

/** Versions that are deprecated (still served, but with Sunset headers). */
export const DEPRECATED_VERSIONS: DeprecationEntry[] = [
  // Example: uncomment to deprecate v1
  // { version: 'v1', sunsetDate: '2027-01-01', migrationUrl: 'https://docs.example.com/api/v2/migration' },
];

const DEPRECATED_VERSION_MAP = new Map<string, DeprecationEntry>(
  DEPRECATED_VERSIONS.map((d) => [d.version, d]),
);

// ---------------------------------------------------------------------------
// Feature flags per API version
// ---------------------------------------------------------------------------

/**
 * Features available per API version.
 * App code can query `req.featureFlags` to guard new functionality.
 */
const VERSION_FEATURE_FLAGS: Record<string, Record<string, boolean>> = {
  v1: {
    'basic-transactions': true,
    disputes: true,
    'bulk-operations': true,
    stats: true,
    webhooks: false,
    'advanced-filters': false,
    'streaming-export': true,
    'bulk-compliance': false,
  },
  v2: {
    'basic-transactions': true,
    disputes: true,
    'bulk-operations': true,
    stats: true,
    webhooks: true,
    'advanced-filters': true,
    'streaming-export': true,
    'bulk-compliance': true,
  },
};

/**
 * Minimum app version required to use each API version.
 * Clients advertising an X-App-Version below the minimum will be served the
 * previous API version to preserve backward compatibility.
 */
const APP_VERSION_TO_API_VERSION: Array<{
  minAppVersion: string;
  apiVersion: string;
}> = [
  { minAppVersion: '2.0.0', apiVersion: 'v2' },
  { minAppVersion: '1.0.0', apiVersion: 'v1' },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeApiVersion(raw: string): string | undefined {
  const m = raw.trim().match(/^v?(\d+)$/i);
  return m ? `v${m[1]}` : undefined;
}

/**
 * Parse a semver-ish string into [major, minor, patch].
 * Returns [0,0,0] for anything that does not parse.
 */
function parseSemVer(v: string): [number, number, number] {
  const parts = v.split('.').map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function semVerGte(a: string, b: string): boolean {
  const [aMaj, aMin, aPat] = parseSemVer(a);
  const [bMaj, bMin, bPat] = parseSemVer(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

/**
 * Select the best API version for an app version string.
 * Falls back to CURRENT_VERSION if no mapping matches.
 */
function resolveApiVersionForApp(appVersion: string): string {
  for (const mapping of APP_VERSION_TO_API_VERSION) {
    if (semVerGte(appVersion, mapping.minAppVersion)) {
      return mapping.apiVersion;
    }
  }
  return CURRENT_VERSION;
}

// ---------------------------------------------------------------------------
// setApiVersion helper (used in route definitions)
// ---------------------------------------------------------------------------

export const setApiVersion =
  (version: string): RequestHandler =>
  (req, _res, next) => {
    (req as VersionedRequest).apiVersion = version;
    next();
  };

// ---------------------------------------------------------------------------
// apiVersionMiddleware
// ---------------------------------------------------------------------------

/**
 * Extracts and resolves the API version for each request.
 *
 * Resolution priority:
 *  1. URL path segment  (/api/v2/...)
 *  2. Accept-Version header
 *  3. Accept header  (application/vnd.api+json;version=v2)
 *  4. X-App-Version header  (app version → mapped API version)
 *  5. Default: CURRENT_VERSION
 */
export const apiVersionMiddleware: RequestHandler = (req, res, next) => {
  const vReq = req as VersionedRequest;

  try {
    let version = CURRENT_VERSION;

    // 1. URL path
    const pathMatch = vReq.path.match(/^\/api\/(v\d+)(?:\/|$)/i);
    if (pathMatch) {
      version = normalizeApiVersion(pathMatch[1]) ?? CURRENT_VERSION;
    } else {
      // 2. Accept-Version header
      const acceptVersionHeader = vReq.get('accept-version');
      if (acceptVersionHeader) {
        const headerVersion = normalizeApiVersion(acceptVersionHeader);
        if (headerVersion) {
          version = headerVersion;
        }
      } else {
        // 3. Accept header
        const acceptHeader = vReq.get('accept');
        const versionMatch = acceptHeader?.match(
          /(?:^|[;\s])version=(v?\d+)/i,
        );
        if (versionMatch) {
          const acceptVersion = normalizeApiVersion(versionMatch[1]);
          if (acceptVersion) version = acceptVersion;
        }
      }
    }

    // 4. X-App-Version override (only when no explicit API version found)
    const appVersionHeader = vReq.get('x-app-version');
    if (appVersionHeader && version === CURRENT_VERSION && !pathMatch) {
      vReq.appVersion = appVersionHeader;
      const mapped = resolveApiVersionForApp(appVersionHeader);
      // Only override if the mapped version is supported
      if (SUPPORTED_VERSIONS.includes(mapped)) {
        version = mapped;
      }
    }

    vReq.apiVersion = version;
    vReq.requestedVersion = version;
    vReq.featureFlags = VERSION_FEATURE_FLAGS[version] ?? {};

    // Response headers
    res.setHeader('API-Version', version);
    res.vary('Accept');
    res.vary('Accept-Version');

    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[API Version] path=${req.path} version=${version} appVersion=${appVersionHeader ?? 'n/a'}`,
      );
    }

    next();
  } catch (error) {
    console.error('[apiVersionMiddleware] error:', error);
    next(error);
  }
};

// ---------------------------------------------------------------------------
// validateVersionMiddleware
// ---------------------------------------------------------------------------

/**
 * Rejects requests targeting unsupported API versions and attaches
 * deprecation headers for deprecated versions.
 */
export const validateVersionMiddleware: RequestHandler = (req, res, next) => {
  const vReq = req as VersionedRequest;
  const apiVersion = vReq.apiVersion ?? CURRENT_VERSION;

  if (!SUPPORTED_VERSIONS.includes(apiVersion)) {
    return res.status(400).json({
      error: 'Unsupported API Version',
      message: `API version ${apiVersion} is not supported. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`,
      supportedVersions: SUPPORTED_VERSIONS,
    });
  }

  const deprecation = DEPRECATED_VERSION_MAP.get(apiVersion);
  if (deprecation) {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', new Date(deprecation.sunsetDate).toUTCString());
    if (deprecation.migrationUrl) {
      res.setHeader(
        'Link',
        `<${deprecation.migrationUrl}>; rel="successor-version"`,
      );
    } else {
      res.setHeader(
        'Link',
        `<https://docs.example.com/api/${CURRENT_VERSION}>; rel="latest-version"`,
      );
    }
  }

  next();
};

// ---------------------------------------------------------------------------
// Helper exports
// ---------------------------------------------------------------------------

export const getApiVersion = (req: Request): string =>
  (req as VersionedRequest).apiVersion ?? CURRENT_VERSION;

/**
 * Check whether a specific feature is enabled for a request's API version.
 */
export const supportsFeature = (version: string, feature: string): boolean =>
  (VERSION_FEATURE_FLAGS[version] ?? {})[feature] === true;

/**
 * Check feature flag directly from the request object.
 */
export const requestSupportsFeature = (
  req: Request,
  feature: string,
): boolean =>
  (req as VersionedRequest).featureFlags?.[feature] === true;

/**
 * Create a version-aware response envelope.
 */
export const createVersionedResponse = (
  version: string,
  data: unknown,
  meta?: Record<string, unknown>,
) => ({
  version,
  data,
  meta: {
    timestamp: new Date().toISOString(),
    ...meta,
  },
});

/**
 * Returns the full deprecation timeline for documentation/tooling.
 */
export const getDeprecationTimeline = (): DeprecationEntry[] =>
  DEPRECATED_VERSIONS;
