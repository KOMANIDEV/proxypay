/**
 * Provider API Schema Change Detection
 *
 * Provider API contracts (mobile money endpoints, Stellar integrations, …)
 * can change silently and break integrations without any HTTP error. This
 * service detects contract changes by:
 *
 *   1. Capturing a canonical snapshot of a provider's API schema
 *      (canonical JSON + SHA-256 hash).
 *   2. Diffing the new snapshot against the last recorded version and
 *      classifying each change as breaking or non-breaking (JSON Schema
 *      aware: removed required fields and removed enum values are breaking).
 *   3. Versioning every capture with semver – MAJOR on breaking changes,
 *      MINOR on additive ones – and persisting the full history.
 *   4. Emitting an alert whenever a change is detected so the integration
 *      team can react before calls start failing.
 *
 * Usage:
 *   await monitorProviderContract("mtn", "collection/requesttopay", schema);
 *
 * The captured schema should be a JSON Schema object describing the request
 * and/or response contract for the provider endpoint.
 */

import { createHash } from "crypto";
import { pool } from "../config/database";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchemaChangeKind = "added" | "removed" | "modified";

export interface SchemaChange {
  kind: SchemaChangeKind;
  /** JSON pointer-ish path, e.g. "properties.payer.partyIdType" */
  path: string;
  breaking: boolean;
  detail: string;
}

export interface ChangeCounts {
  added: number;
  removed: number;
  modified: number;
  breaking: number;
}

export interface ProviderSchemaVersion {
  id: string;
  provider: string;
  endpoint: string;
  version: string;
  schemaHash: string;
  schema: Record<string, unknown>;
  breakingChangePaths: string[];
  changeCounts: ChangeCounts;
  detectedAt: Date;
  alertedAt: Date | null;
  createdAt: Date;
}

export interface SchemaDiffResult {
  changed: boolean;
  changes: SchemaChange[];
  breakingChanges: SchemaChange[];
  previousVersion: string | null;
  nextVersion: string;
}

export interface MonitorResult {
  changed: boolean;
  version: string;
  changes: SchemaChange[];
  breakingChanges: SchemaChange[];
  alerted: boolean;
  record: ProviderSchemaVersion;
}

const ALERT_WEBHOOK_URL = process.env.PROVIDER_SCHEMA_ALERT_WEBHOOK_URL;
const BASE_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Canonicalisation & hashing
// ---------------------------------------------------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON serialisation of a schema – key order independent so
 * cosmetic reordering never registers as a contract change.
 */
export function canonicalizeSchema(schema: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(schema));
}

/**
 * SHA-256 digest of the canonical schema. Used to detect whether a contract
 * changed at all without storing duplicate snapshots.
 */
export function computeSchemaHash(schema: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeSchema(schema)).digest("hex");
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEnumValueRemoved(prev: unknown, next: unknown): boolean {
  return (
    Array.isArray(prev) &&
    Array.isArray(next) &&
    (prev as unknown[]).some((v) => !(next as unknown[]).includes(v))
  );
}

/**
 * Container keys whose children are field schemas rather than plain values.
 * The required-ness of children under these keys is inherited from the
 * parent schema's `required` array.
 */
const SCHEMA_CONTAINER_KEYS = new Set([
  "properties",
  "patternProperties",
  "items",
  "additionalProperties",
  "definitions",
  "$defs",
]);

/**
 * Diff two JSON Schema objects and classify every change.
 *
 * Breaking rules:
 *   - A required field is removed.
 *   - A field's type changes.
 *   - An enum value is removed.
 *   - A required field's sub-structure changes incompatibly (recursive).
 *
 * Non-breaking rules:
 *   - An optional field is added.
 *   - An optional field is removed.
 *   - A non-required field's value/default changes.
 *
 * `prevRequiredContext` / `nextRequiredContext` carry the `required` array
 * of the parent schema down into `properties`/`items` containers, because
 * that is where the JSON Schema spec actually declares required-ness for
 * the child fields.
 */
export function diffSchemas(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  pathPrefix = "",
  prevRequiredContext: string[] = [],
  nextRequiredContext: string[] = [],
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const pathAt = (key: string) => (pathPrefix ? `${pathPrefix}.${key}` : key);

  const prevRequiredList = Array.isArray(previous.required)
    ? (previous.required as string[])
    : prevRequiredContext;
  const nextRequiredList = Array.isArray(next.required)
    ? (next.required as string[])
    : nextRequiredContext;

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

  for (const key of keys) {
    const path = pathAt(key);
    const prevValue = previous[key];
    const nextValue = next[key];
    const prevRequired = prevRequiredList.includes(key);
    const nextRequired = nextRequiredList.includes(key);

    // Field added
    if (prevValue === undefined) {
      changes.push({
        kind: "added",
        path,
        breaking: nextRequired,
        detail: nextRequired
          ? `New required field "${path}" added`
          : `New optional field "${path}" added`,
      });
      continue;
    }

    // Field removed
    if (nextValue === undefined) {
      changes.push({
        kind: "removed",
        path,
        breaking: prevRequired,
        detail: prevRequired
          ? `Required field "${path}" removed`
          : `Optional field "${path}" removed`,
      });
      continue;
    }

    // Both present – inspect type change first
    if (typeof prevValue !== typeof nextValue) {
      changes.push({
        kind: "modified",
        path,
        breaking: true,
        detail: `Type of "${path}" changed from ${typeof prevValue} to ${typeof nextValue}`,
      });
      continue;
    }

    // Enum value removed
    if (isEnumValueRemoved(prevValue, nextValue)) {
      changes.push({
        kind: "modified",
        path,
        breaking: true,
        detail: `Enum values removed from "${path}"`,
      });
      continue;
    }

    if (isObject(prevValue) && isObject(nextValue)) {
      const isContainer = SCHEMA_CONTAINER_KEYS.has(key);

      // A field schema whose declared type changed is a breaking change of
      // the field itself – no need to descend into its sub-schema.
      if (
        !isContainer &&
        prevValue.type !== undefined &&
        prevValue.type !== nextValue.type
      ) {
        changes.push({
          kind: "modified",
          path,
          breaking: true,
          detail: `Type of field "${path}" changed from ${String(prevValue.type)} to ${String(nextValue.type)}`,
        });
        continue;
      }

      // Enum values removed from a field are breaking – report at the field
      // path for actionable alerts.
      if (
        !isContainer &&
        Array.isArray(prevValue.enum) &&
        Array.isArray(nextValue.enum) &&
        (prevValue.enum as unknown[]).some(
          (v) => !(nextValue.enum as unknown[]).includes(v),
        )
      ) {
        changes.push({
          kind: "modified",
          path,
          breaking: true,
          detail: `Enum values removed from field "${path}"`,
        });
        continue;
      }

      // Children of container keys inherit this schema's required list;
      // children of a field schema use that field schema's own required.
      const childPrevContext = isContainer
        ? prevRequiredList
        : Array.isArray(prevValue.required)
          ? (prevValue.required as string[])
          : [];
      const childNextContext = isContainer
        ? nextRequiredList
        : Array.isArray(nextValue.required)
          ? (nextValue.required as string[])
          : [];
      changes.push(
        ...diffSchemas(
          prevValue,
          nextValue,
          path,
          childPrevContext,
          childNextContext,
        ),
      );
      continue;
    }

    if (Array.isArray(prevValue) && Array.isArray(nextValue)) {
      const normalized =
        JSON.stringify(prevValue) === JSON.stringify(nextValue);
      if (!normalized) {
        changes.push({
          kind: "modified",
          path,
          breaking: prevRequired,
          detail: `Array value of "${path}" changed`,
        });
      }
      continue;
    }

    if (JSON.stringify(prevValue) !== JSON.stringify(nextValue)) {
      changes.push({
        kind: "modified",
        path,
        breaking: prevRequired,
        detail: `Value of "${path}" changed (${JSON.stringify(prevValue)} → ${JSON.stringify(nextValue)})`,
      });
    }
  }

  // Handle required-list-only changes (a field promoted to required).
  const promoted = nextRequiredList.filter(
    (name) => !prevRequiredList.includes(name),
  );
  for (const name of promoted) {
    const path = pathAt(name);
    // Only report if we did not already report the field as added.
    if (previous[name] !== undefined) {
      changes.push({
        kind: "modified",
        path,
        breaking: true,
        detail: `Field "${path}" promoted to required`,
      });
    }
  }

  return changes;
}

function toCounts(changes: SchemaChange[]): ChangeCounts {
  return {
    added: changes.filter((c) => c.kind === "added").length,
    removed: changes.filter((c) => c.kind === "removed").length,
    modified: changes.filter((c) => c.kind === "modified").length,
    breaking: changes.filter((c) => c.breaking).length,
  };
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

function bumpVersion(current: string, changes: SchemaChange[]): string {
  const [major, minor, patch] = current
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  const hasBreaking = changes.some((c) => c.breaking);
  const hasAny = changes.length > 0;

  if (hasBreaking) return `${major + 1}.0.0`;
  if (hasAny) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch}`;
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

export interface SchemaChangeAlert {
  provider: string;
  endpoint: string;
  version: string;
  changes: SchemaChange[];
  breakingChanges: SchemaChange[];
  detectedAt: string;
}

/**
 * Emit a change alert through the configured channels:
 *   - structured log (always)
 *   - optional webhook (webhookUrl, defaults to PROVIDER_SCHEMA_ALERT_WEBHOOK_URL) – fire-and-forget
 */
export async function sendSchemaChangeAlert(
  alert: SchemaChangeAlert,
  webhookUrl: string = ALERT_WEBHOOK_URL ?? "",
): Promise<boolean> {
  const summary = `${alert.provider}/${alert.endpoint} changed to v${alert.version}: ${alert.changes.length} change(s), ${alert.breakingChanges.length} breaking`;

  if (alert.breakingChanges.length > 0) {
    logger.error({ alert }, `[provider-schema] ${summary}`);
  } else {
    logger.warn({ alert }, `[provider-schema] ${summary}`);
  }

  if (!webhookUrl) return false;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "provider.schema.changed",
        timestamp: alert.detectedAt,
        data: alert,
      }),
    });
    return response.ok;
  } catch {
    logger.error(
      { provider: alert.provider, endpoint: alert.endpoint },
      "[provider-schema] Failed to deliver schema change alert webhook",
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function mapVersionRow(row: any): ProviderSchemaVersion {
  return {
    id: String(row.id),
    provider: row.provider,
    endpoint: row.endpoint,
    version: row.version,
    schemaHash: row.schema_hash,
    schema: row.schema,
    breakingChangePaths: row.breaking_change_paths ?? [],
    changeCounts: row.change_counts ?? {
      added: 0,
      removed: 0,
      modified: 0,
      breaking: 0,
    },
    detectedAt: new Date(row.detected_at),
    alertedAt: row.alerted_at ? new Date(row.alerted_at) : null,
    createdAt: new Date(row.created_at),
  };
}

const VERSION_COLUMNS = `
  id, provider, endpoint, version, schema_hash, schema,
  breaking_change_paths, change_counts, detected_at, alerted_at, created_at
`;

/**
 * Fetch the most recently captured schema version for a provider endpoint.
 */
export async function getLatestSchemaVersion(
  provider: string,
  endpoint: string,
): Promise<ProviderSchemaVersion | null> {
  const { rows } = await pool.query(
    `SELECT ${VERSION_COLUMNS}
     FROM provider_api_schema_versions
     WHERE provider = $1 AND endpoint = $2
     ORDER BY detected_at DESC
     LIMIT 1`,
    [provider, endpoint],
  );
  return rows[0] ? mapVersionRow(rows[0]) : null;
}

/**
 * Fetch the full version history for a provider endpoint.
 */
export async function getSchemaVersionHistory(
  provider: string,
  endpoint: string,
  limit = 50,
): Promise<ProviderSchemaVersion[]> {
  const { rows } = await pool.query(
    `SELECT ${VERSION_COLUMNS}
     FROM provider_api_schema_versions
     WHERE provider = $1 AND endpoint = $2
     ORDER BY detected_at DESC
     LIMIT $3`,
    [provider, endpoint, limit],
  );
  return rows.map(mapVersionRow);
}

async function insertSchemaVersion(params: {
  provider: string;
  endpoint: string;
  version: string;
  schemaHash: string;
  schema: Record<string, unknown>;
  breakingChangePaths: string[];
  changeCounts: ChangeCounts;
  alertedAt?: Date | null;
}): Promise<ProviderSchemaVersion> {
  const { rows } = await pool.query(
    `INSERT INTO provider_api_schema_versions (
       provider, endpoint, version, schema_hash, schema,
       breaking_change_paths, change_counts, alerted_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider, endpoint, version) DO NOTHING
     RETURNING ${VERSION_COLUMNS}`,
    [
      params.provider,
      params.endpoint,
      params.version,
      params.schemaHash,
      JSON.stringify(params.schema),
      params.breakingChangePaths,
      JSON.stringify(params.changeCounts),
      params.alertedAt ?? null,
    ],
  );
  return mapVersionRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Capture a provider contract, diff it against the latest known version,
 * alert on changes and record the new version.
 *
 * @param provider  provider name (e.g. "mtn")
 * @param endpoint  endpoint identifier (e.g. "collection/requesttopay")
 * @param schema    JSON Schema describing the contract
 * @param options.alertOnChange  emit alerts when a change is detected (default true)
 * @param options.alertHook      override the webhook URL (used in tests)
 */
export async function monitorProviderContract(
  provider: string,
  endpoint: string,
  schema: Record<string, unknown>,
  options: { alertOnChange?: boolean; alertHook?: string } = {},
): Promise<MonitorResult> {
  const schemaHash = computeSchemaHash(schema);
  const previous = await getLatestSchemaVersion(provider, endpoint);

  // Identical contract – no change, no new version.
  if (previous && previous.schemaHash === schemaHash) {
    return {
      changed: false,
      version: previous.version,
      changes: [],
      breakingChanges: [],
      alerted: false,
      record: previous,
    };
  }

  const changes = previous ? diffSchemas(previous.schema, schema) : [];
  const breakingChanges = changes.filter((c) => c.breaking);
  const nextVersion = previous
    ? bumpVersion(previous.version, changes)
    : BASE_VERSION;

  // Only alert when a contract that was already tracked has actually changed;
  // first captures should use recordProviderContractBaseline() instead.
  const alertOnChange = options.alertOnChange ?? true;
  let alerted = false;
  if (alertOnChange && previous && changes.length > 0) {
    alerted = await sendSchemaChangeAlert(
      {
        provider,
        endpoint,
        version: nextVersion,
        changes,
        breakingChanges,
        detectedAt: new Date().toISOString(),
      },
      options.alertHook ?? ALERT_WEBHOOK_URL ?? "",
    );
  }

  const changeCounts = toCounts(changes);
  const record = await insertSchemaVersion({
    provider,
    endpoint,
    version: nextVersion,
    schemaHash,
    schema,
    breakingChangePaths: breakingChanges.map((c) => c.path),
    changeCounts,
    alertedAt: alerted ? new Date() : null,
  });

  return {
    changed: true,
    version: nextVersion,
    changes,
    breakingChanges,
    alerted,
    record,
  };
}

/**
 * Establish a baseline version (1.0.0) for a provider endpoint without
 * alerting. Useful for onboarding endpoints that are already live.
 */
export async function recordProviderContractBaseline(
  provider: string,
  endpoint: string,
  schema: Record<string, unknown>,
): Promise<ProviderSchemaVersion> {
  const schemaHash = computeSchemaHash(schema);
  const existing = await getLatestSchemaVersion(provider, endpoint);
  if (existing && existing.schemaHash === schemaHash) return existing;

  return insertSchemaVersion({
    provider,
    endpoint,
    version: BASE_VERSION,
    schemaHash,
    schema,
    breakingChangePaths: [],
    changeCounts: { added: 0, removed: 0, modified: 0, breaking: 0 },
  });
}

// ---------------------------------------------------------------------------
// Detection helpers (pure, exported for testing / reuse)
// ---------------------------------------------------------------------------

/**
 * Diff the captured schema against the latest stored version without
 * persisting anything. Pure convenience wrapper around diffSchemas +
 * versioning.
 */
export function analyzeSchemaChange(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): SchemaDiffResult {
  const changes = diffSchemas(previous, next);
  const breakingChanges = changes.filter((c) => c.breaking);
  const previousVersion = "1.0.0";
  return {
    changed: changes.length > 0,
    changes,
    breakingChanges,
    previousVersion,
    nextVersion: bumpVersion(previousVersion, changes),
  };
}
