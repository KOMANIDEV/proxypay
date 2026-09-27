/**
 * #484 – Provider Contract Version Management
 *
 * `providerSchemaMonitorService` already detects *shape* changes in a provider
 * contract. This module covers the orthogonal concern of which API **version**
 * the bridge is pinned to:
 *
 *   1. `registerProviderVersion()` records a version together with the
 *      request-formatting profile that must be applied when calling it, and
 *      emits a `registered` notification.
 *   2. `validateCompatibility()` checks a provider version against the bridge
 *      version (and any declared constraints) so an incompatible upgrade is
 *      rejected before it reaches production traffic.
 *   3. `formatRequest()` applies the version-specific request profile – field
 *      renames, added/removed fields, envelope wrapping and header injection.
 *   4. `setVersionStatus()` drives the deprecation lifecycle and emits the
 *      matching `deprecated` / `retired` notifications.
 *
 * All lifecycle events are written to `provider_api_version_events` so
 * operators have an immutable notification trail.
 */

import { queryRead, queryWrite } from "../config/database";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderVersionStatus = "active" | "deprecated" | "retired";

export type ProviderVersionEventType =
  | "registered"
  | "activated"
  | "deprecated"
  | "retired"
  | "incompatible";

/**
 * Version-specific request formatting profile.
 *
 * - `renameFields`   : legacy field name → current field name
 * - `dropFields`     : fields that must no longer be sent
 * - `defaults`       : fields injected with a constant when absent
 * - `header`         : headers to attach to every request
 * - `envelope`       : when set, the payload is wrapped as `{ [envelope]: body }`
 */
export interface RequestFormatProfile {
  renameFields?: Record<string, string>;
  dropFields?: string[];
  defaults?: Record<string, unknown>;
  header?: Record<string, string>;
  envelope?: string | null;
}

export interface ProviderApiVersion {
  id: string;
  provider: string;
  version: string;
  status: ProviderVersionStatus;
  requestFormat: RequestFormatProfile;
  changelog: string | null;
  effectiveFrom: Date;
  deprecatedAt: Date | null;
  sunsetAt: Date | null;
  createdAt: Date;
}

export interface CompatibilityResult {
  compatible: boolean;
  provider: string;
  providerVersion: string;
  bridgeVersion: string;
  reasons: string[];
}

export interface VersionNotification {
  provider: string;
  version: string;
  eventType: ProviderVersionEventType;
  payload: Record<string, unknown>;
  createdAt: string;
  delivered: boolean;
}

export interface RegisterVersionInput {
  provider: string;
  version: string;
  requestFormat?: RequestFormatProfile;
  changelog?: string;
  sunsetAt?: Date | null;
}

const VERSION_COLUMNS = `
  id, provider, version, status, request_format, changelog,
  effective_from, deprecated_at, sunset_at, created_at
`;

/** Current bridge version, overridable for compatibility testing. */
const BRIDGE_VERSION = process.env.BRIDGE_API_VERSION ?? "1.0.0";

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapVersionRow(row: any): ProviderApiVersion {
  return {
    id: String(row.id),
    provider: row.provider,
    version: row.version,
    status: row.status as ProviderVersionStatus,
    requestFormat: (row.request_format ?? {}) as RequestFormatProfile,
    changelog: row.changelog ?? null,
    effectiveFrom: new Date(row.effective_from),
    deprecatedAt: row.deprecated_at ? new Date(row.deprecated_at) : null,
    sunsetAt: row.sunset_at ? new Date(row.sunset_at) : null,
    createdAt: new Date(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

/** Minimal semver comparison – returns >0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    String(v)
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Version tracking
// ---------------------------------------------------------------------------

/**
 * Register a provider API version. Re-registering the same version updates
 * its formatting profile and lifecycle status rather than creating a duplicate.
 */
export async function registerProviderVersion(
  input: RegisterVersionInput,
): Promise<ProviderApiVersion> {
  const { rows } = await queryWrite<any>(
    `INSERT INTO provider_api_versions
       (provider, version, status, request_format, changelog, sunset_at)
     VALUES ($1, $2, 'active', $3, $4, $5)
     ON CONFLICT (provider, version) DO UPDATE
       SET request_format = EXCLUDED.request_format,
           changelog      = EXCLUDED.changelog,
           sunset_at      = EXCLUDED.sunset_at
     RETURNING ${VERSION_COLUMNS}`,
    [
      input.provider,
      input.version,
      JSON.stringify(input.requestFormat ?? {}),
      input.changelog ?? null,
      input.sunsetAt ?? null,
    ],
  );

  const record = mapVersionRow(rows[0]);
  await emitVersionEvent({
    provider: input.provider,
    version: input.version,
    eventType: "registered",
    payload: { changelog: input.changelog ?? null },
  });
  logger.info(
    { provider: input.provider, version: input.version },
    "[provider-versions] version registered",
  );
  return record;
}

export async function getProviderVersion(
  provider: string,
  version: string,
): Promise<ProviderApiVersion | null> {
  const { rows } = await queryRead<any>(
    `SELECT ${VERSION_COLUMNS} FROM provider_api_versions
      WHERE provider = $1 AND version = $2`,
    [provider, version],
  );
  return rows[0] ? mapVersionRow(rows[0]) : null;
}

/** The version currently serving traffic for a provider. */
export async function getActiveProviderVersion(
  provider: string,
): Promise<ProviderApiVersion | null> {
  const { rows } = await queryRead<any>(
    `SELECT ${VERSION_COLUMNS} FROM provider_api_versions
      WHERE provider = $1 AND status = 'active'
      ORDER BY effective_from DESC
      LIMIT 1`,
    [provider],
  );
  return rows[0] ? mapVersionRow(rows[0]) : null;
}

export async function listProviderVersions(
  provider?: string,
): Promise<ProviderApiVersion[]> {
  const { rows } = provider
    ? await queryRead<any>(
        `SELECT ${VERSION_COLUMNS} FROM provider_api_versions
          WHERE provider = $1 ORDER BY effective_from DESC`,
        [provider],
      )
    : await queryRead<any>(
        `SELECT ${VERSION_COLUMNS} FROM provider_api_versions
          ORDER BY provider, effective_from DESC`,
      );
  return rows.map(mapVersionRow);
}

// ---------------------------------------------------------------------------
// Compatibility validation
// ---------------------------------------------------------------------------

/**
 * Declare compatibility between a provider version and a bridge version.
 * `constraints` may carry `{ maxBridgeVersion }` or `{ minBridgeVersion }` to
 * express a bounded compatibility window.
 */
export async function declareCompatibility(
  provider: string,
  providerVersion: string,
  bridgeVersion: string,
  compatible: boolean,
  constraints: Record<string, unknown> = {},
): Promise<void> {
  await queryWrite(
    `INSERT INTO provider_api_version_compat
       (provider, provider_version, bridge_version, compatible, constraints)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (provider, provider_version, bridge_version) DO UPDATE
       SET compatible  = EXCLUDED.compatible,
           constraints = EXCLUDED.constraints,
           checked_at  = NOW()`,
    [
      provider,
      providerVersion,
      bridgeVersion,
      compatible,
      JSON.stringify(constraints),
    ],
  );
}

/**
 * Validate whether a provider version can be used by a bridge version.
 *
 * A version is compatible when:
 *   - it exists and is not `retired`,
 *   - its sunset date has not elapsed (or has not yet passed within grace),
 *   - an explicit compatibility row, if present, says `compatible`,
 *   - the declared `min`/`maxBridgeVersion` window contains the bridge version.
 */
export async function validateCompatibility(
  provider: string,
  providerVersion: string,
  bridgeVersion: string = BRIDGE_VERSION,
  options: { graceHours?: number } = {},
): Promise<CompatibilityResult> {
  const reasons: string[] = [];
  const record = await getProviderVersion(provider, providerVersion);

  if (!record) {
    reasons.push(`Provider version ${providerVersion} is not registered`);
    return {
      compatible: false,
      provider,
      providerVersion,
      bridgeVersion,
      reasons,
    };
  }

  if (record.status === "retired") {
    reasons.push(`Provider version ${providerVersion} has been retired`);
  }

  if (record.status === "deprecated" && !record.sunsetAt) {
    reasons.push(`Provider version ${providerVersion} is deprecated`);
  }

  if (record.sunsetAt) {
    const graceMs = (options.graceHours ?? 0) * 60 * 60 * 1000;
    if (Date.now() > record.sunsetAt.getTime() + graceMs) {
      reasons.push(
        `Provider version ${providerVersion} passed its sunset date (${record.sunsetAt.toISOString()})`,
      );
    }
  }

  const { rows } = await queryRead<any>(
    `SELECT compatible, constraints
       FROM provider_api_version_compat
      WHERE provider = $1 AND provider_version = $2 AND bridge_version = $3`,
    [provider, providerVersion, bridgeVersion],
  );

  if (rows[0]) {
    if (!rows[0].compatible) {
      reasons.push(
        `Declared incompatible with bridge version ${bridgeVersion}`,
      );
    }
    const constraints = rows[0].constraints ?? {};
    if (constraints.maxBridgeVersion) {
      if (compareVersions(bridgeVersion, constraints.maxBridgeVersion) > 0) {
        reasons.push(
          `Bridge version ${bridgeVersion} exceeds supported maximum ${constraints.maxBridgeVersion}`,
        );
      }
    }
    if (constraints.minBridgeVersion) {
      if (compareVersions(bridgeVersion, constraints.minBridgeVersion) < 0) {
        reasons.push(
          `Bridge version ${bridgeVersion} is below supported minimum ${constraints.minBridgeVersion}`,
        );
      }
    }
  }

  return {
    compatible: reasons.length === 0,
    provider,
    providerVersion,
    bridgeVersion,
    reasons,
  };
}

/**
 * Guard used by provider callers: throws when the pinned version is not
 * compatible so the failure happens before a request is dispatched.
 */
export async function assertCompatibleVersion(
  provider: string,
  providerVersion: string,
  bridgeVersion: string = BRIDGE_VERSION,
): Promise<void> {
  const result = await validateCompatibility(
    provider,
    providerVersion,
    bridgeVersion,
  );
  if (!result.compatible) {
    await emitVersionEvent({
      provider,
      version: providerVersion,
      eventType: "incompatible",
      payload: { reasons: result.reasons, bridgeVersion },
    });
    throw new Error(
      `Incompatible provider version ${provider}/${providerVersion}: ${result.reasons.join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Version-specific request formatting
// ---------------------------------------------------------------------------

/**
 * Apply a version's request-formatting profile to an outbound payload.
 * Returns a new object – the input is never mutated.
 */
export function formatRequest<T extends Record<string, any>>(
  payload: T,
  profile: RequestFormatProfile,
): Record<string, unknown> {
  let result: Record<string, unknown> = { ...payload };

  for (const [legacy, current] of Object.entries(profile.renameFields ?? {})) {
    if (legacy in result) {
      const value = result[legacy];
      delete result[legacy];
      if (result[current] === undefined) {
        result[current] = value;
      }
    }
  }

  for (const field of profile.dropFields ?? []) {
    delete result[field];
  }

  for (const [field, value] of Object.entries(profile.defaults ?? {})) {
    if (result[field] === undefined || result[field] === null) {
      result[field] = value;
    }
  }

  if (profile.envelope) {
    result = { [profile.envelope]: result };
  }

  return result;
}

/** Resolve the headers a version requires for every request. */
export function buildVersionHeaders(
  profile: RequestFormatProfile,
): Record<string, string> {
  return { ...(profile.header ?? {}) };
}

/** Format a request for a registered provider version. */
export async function formatRequestForVersion<T extends Record<string, any>>(
  provider: string,
  version: string,
  payload: T,
): Promise<Record<string, unknown>> {
  const record = await getProviderVersion(provider, version);
  return formatRequest(payload, record?.requestFormat ?? {});
}

// ---------------------------------------------------------------------------
// Lifecycle + notifications
// ---------------------------------------------------------------------------

/**
 * Move a version through its lifecycle. `deprecated` accepts a sunset date;
 * `retired` is terminal. Every transition emits a notification.
 */
export async function setVersionStatus(
  provider: string,
  version: string,
  status: ProviderVersionStatus,
  options: { sunsetAt?: Date | null } = {},
): Promise<ProviderApiVersion | null> {
  const { rows } = await queryWrite<any>(
    `UPDATE provider_api_versions
        SET status = $3,
            deprecated_at = CASE WHEN $3 = 'deprecated' THEN NOW() ELSE deprecated_at END,
            sunset_at = COALESCE($4, sunset_at)
      WHERE provider = $1 AND version = $2
      RETURNING ${VERSION_COLUMNS}`,
    [provider, version, status, options.sunsetAt ?? null],
  );

  if (!rows[0]) {
    logger.warn(
      { provider, version },
      "[provider-versions] cannot change status of unknown version",
    );
    return null;
  }

  const eventType: ProviderVersionEventType =
    status === "deprecated"
      ? "deprecated"
      : status === "retired"
        ? "retired"
        : "activated";

  await emitVersionEvent({
    provider,
    version,
    eventType,
    payload: { sunsetAt: options.sunsetAt?.toISOString() ?? null },
  });

  return mapVersionRow(rows[0]);
}

const ALERT_WEBHOOK = process.env.PROVIDER_VERSION_ALERT_WEBHOOK_URL;

/**
 * Record a version lifecycle event and deliver the notification.
 * Delivery is fire-and-forget: a failing webhook must not break the caller.
 */
export async function emitVersionEvent(
  input: Omit<VersionNotification, "delivered" | "createdAt">,
): Promise<VersionNotification> {
  const createdAt = new Date().toISOString();

  let delivered = false;
  if (ALERT_WEBHOOK) {
    try {
      const response = await fetch(ALERT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: `provider.version.${input.eventType}`,
          timestamp: createdAt,
          data: input,
        }),
      });
      delivered = response.ok;
    } catch (error) {
      logger.warn(
        { error, provider: input.provider },
        "[provider-versions] failed to deliver version notification",
      );
    }
  }

  try {
    await queryWrite(
      `INSERT INTO provider_api_version_events
         (provider, version, event_type, payload, notified_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        input.provider,
        input.version,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        delivered ? new Date() : null,
      ],
    );
  } catch (error) {
    logger.warn(
      { error, provider: input.provider },
      "[provider-versions] failed to persist version event",
    );
  }

  if (input.eventType === "incompatible" || statusRequiresAlert(input.eventType)) {
    logger.error(
      { provider: input.provider, version: input.version },
      `[provider-versions] ${input.eventType} notification`,
    );
  }

  return { ...input, createdAt, delivered };
}

function statusRequiresAlert(eventType: ProviderVersionEventType): boolean {
  return eventType === "deprecated" || eventType === "retired";
}

export async function listVersionEvents(
  provider: string,
  limit = 50,
): Promise<VersionNotification[]> {
  const { rows } = await queryRead<any>(
    `SELECT provider, version, event_type, payload, created_at, notified_at
       FROM provider_api_version_events
      WHERE provider = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [provider, limit],
  );

  return rows.map((row) => ({
    provider: row.provider,
    version: row.version,
    eventType: row.event_type,
    payload: row.payload ?? {},
    createdAt: new Date(row.created_at).toISOString(),
    delivered: Boolean(row.notified_at),
  }));
}
