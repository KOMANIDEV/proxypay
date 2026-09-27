/**
 * OpenAPI Deprecation Handler — Issue #245
 *
 * Enhances the generated OpenAPI document by:
 *   1. Marking registered deprecated endpoints with `deprecated: true`.
 *   2. Injecting x-sunset and x-deprecation-date extension fields.
 *   3. Appending migration guidance to endpoint descriptions.
 *
 * Call `enhanceOpenApiWithDeprecations(spec)` after `generateOpenAPIDocument()`
 * to produce an enriched spec for Swagger UI / Redoc.
 */

import { DeprecationRegistry, DeprecationEntry } from '../middleware/deprecation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenApiOperation {
  deprecated?: boolean;
  description?: string;
  summary?: string;
  'x-sunset'?: string;
  'x-deprecation-date'?: string;
  'x-replacement'?: string;
  [key: string]: unknown;
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
  [key: string]: unknown;
}

interface OpenApiDocument {
  paths?: Record<string, OpenApiPathItem>;
  [key: string]: unknown;
}

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a DeprecationEntry path matches the given OpenAPI path key.
 * Handles both exact string matches and simple prefix matches.
 */
function pathMatches(entry: DeprecationEntry, openapiPath: string): boolean {
  if (entry.path instanceof RegExp) {
    return entry.path.test(openapiPath);
  }
  return openapiPath === entry.path || openapiPath.startsWith(entry.path as string);
}

/**
 * Builds a human-readable migration note appended to the operation description.
 */
function buildMigrationNote(entry: DeprecationEntry): string {
  const parts: string[] = ['\n\n> ⚠️ **Deprecated**'];

  if (entry.deprecatedSince) {
    parts.push(`> Deprecated since: \`${entry.deprecatedSince}\``);
  }

  if (entry.sunsetDate) {
    parts.push(`> Sunset date: \`${entry.sunsetDate.toISOString().split('T')[0]}\``);
  }

  if (entry.replacement) {
    parts.push(`> **Migration**: Use \`${entry.replacement}\` instead.`);
  }

  if (entry.reason) {
    parts.push(`> ${entry.reason}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Takes a raw OpenAPI document and enhances it with deprecation metadata
 * sourced from the DeprecationRegistry.
 *
 * The input document is mutated in place and also returned for convenience.
 *
 * @param doc  OpenAPI 3.x document produced by `generateOpenAPIDocument()`
 * @returns    The same document with deprecation annotations applied
 */
export function enhanceOpenApiWithDeprecations(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const openApiDoc = doc as OpenApiDocument;
  if (!openApiDoc.paths) return doc;

  const entries = DeprecationRegistry.getAll();
  if (entries.length === 0) return doc;

  for (const [pathKey, pathItem] of Object.entries(openApiDoc.paths)) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!operation) continue;

      // Find a matching deprecation entry
      const entry = entries.find(
        (e) =>
          pathMatches(e, pathKey) &&
          (!e.method || e.method.toLowerCase() === method),
      );

      if (!entry) continue;

      // Mark as deprecated in the OpenAPI spec
      operation.deprecated = true;

      // Inject extension fields for tooling
      if (entry.sunsetDate) {
        operation['x-sunset'] = entry.sunsetDate.toISOString().split('T')[0];
      }
      if (entry.deprecatedSince) {
        operation['x-deprecation-date'] = entry.deprecatedSince;
      }
      if (entry.replacement) {
        operation['x-replacement'] = entry.replacement;
      }

      // Append migration guidance to the description
      const migrationNote = buildMigrationNote(entry);
      operation.description = (operation.description ?? operation.summary ?? '') + migrationNote;
    }
  }

  return doc;
}

/**
 * Returns a summary of all deprecated endpoints for inclusion in changelogs
 * or admin dashboards.
 *
 * Each entry includes the path, method, sunset date, and replacement.
 */
export function getDeprecationTimeline(): Array<{
  path: string;
  method: string;
  deprecatedSince: string | undefined;
  sunsetDate: string | undefined;
  replacement: string | undefined;
  reason: string | undefined;
}> {
  return DeprecationRegistry.getAll().map((entry) => ({
    path: entry.path instanceof RegExp ? entry.path.source : entry.path,
    method: entry.method ?? 'ALL',
    deprecatedSince: entry.deprecatedSince,
    sunsetDate: entry.sunsetDate?.toISOString().split('T')[0],
    replacement: entry.replacement,
    reason: entry.reason,
  }));
}
