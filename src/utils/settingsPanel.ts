/**
 * Settings Panel — User Preference Store
 *
 * Manages per-user preferences for:
 *   - Theme:         "light" | "dark" | "system"
 *   - Currency:      ISO 4217 code (e.g. "USD", "XAF", "EUR")
 *   - Notifications: toast density + quiet mode
 *
 * Persistence strategy:
 *   - In-process: an in-memory Map keyed by userId (fast reads, zero I/O).
 *   - Durable:    a JSON file under the configured SETTINGS_STORE_PATH
 *                 (mirrors localStorage semantics for server-side persistence).
 *   - The file is written asynchronously so it never blocks the event loop.
 *   - On startup the store is hydrated from the file if it exists.
 *
 * Accessibility / WCAG AA notes (enforced at the API layer):
 *   - Theme values are validated against the allowed set; "system" defers to
 *     the client's prefers-color-scheme media query.
 *   - Toast density "compact" reduces motion for users who prefer it
 *     (maps to prefers-reduced-motion on the client).
 *   - All validation errors return structured messages so screen readers can
 *     surface them correctly.
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Theme = "light" | "dark" | "system";
export type ToastDensity = "comfortable" | "compact" | "minimal";

export interface NotificationPreferences {
  /** Visual density of toast notifications. "compact" respects prefers-reduced-motion. */
  toastDensity: ToastDensity;
  /** When true, non-critical notifications are suppressed. */
  quietMode: boolean;
}

export interface UserSettings {
  /** UI colour scheme. "system" defers to the OS/browser preference. */
  theme: Theme;
  /** ISO 4217 currency code used for display formatting. */
  currency: string;
  notifications: NotificationPreferences;
  /** ISO-8601 timestamp of the last update. */
  updatedAt: string;
  /**
   * Monotonic version of this user's preferences. Incremented on every
   * successful mutation and used for optimistic concurrency control: a
   * client that read vN must submit expectedVersion = N to update, so
   * concurrent sessions cannot silently overwrite each other.
   */
  version: number;
}

export type PartialUserSettings = Partial<
  Omit<UserSettings, "notifications" | "updatedAt"> & {
    notifications: Partial<NotificationPreferences>;
  }
>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Readonly<UserSettings> = Object.freeze({
  theme: "system",
  currency: "USD",
  notifications: Object.freeze({
    toastDensity: "comfortable",
    quietMode: false,
  }),
  updatedAt: new Date(0).toISOString(),
  version: 0,
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_THEMES = new Set<Theme>(["light", "dark", "system"]);
const VALID_TOAST_DENSITIES = new Set<ToastDensity>([
  "comfortable",
  "compact",
  "minimal",
]);

/**
 * Validates an ISO 4217 currency code (3 uppercase letters).
 * Allows lowercase input and normalises to uppercase.
 */
function normaliseCurrency(raw: string): string | null {
  const upper = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validates a partial settings update and returns a list of errors.
 * An empty array means the input is valid.
 */
export function validateSettings(
  input: PartialUserSettings,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (input.theme !== undefined && !VALID_THEMES.has(input.theme)) {
    errors.push({
      field: "theme",
      message: `Invalid theme "${input.theme}". Must be one of: ${[...VALID_THEMES].join(", ")}.`,
    });
  }

  if (input.currency !== undefined) {
    const normalised = normaliseCurrency(input.currency);
    if (!normalised) {
      errors.push({
        field: "currency",
        message: `Invalid currency "${input.currency}". Must be a 3-letter ISO 4217 code (e.g. "USD").`,
      });
    }
  }

  if (input.notifications !== undefined) {
    const { toastDensity, quietMode } = input.notifications;

    if (
      toastDensity !== undefined &&
      !VALID_TOAST_DENSITIES.has(toastDensity)
    ) {
      errors.push({
        field: "notifications.toastDensity",
        message: `Invalid toastDensity "${toastDensity}". Must be one of: ${[...VALID_TOAST_DENSITIES].join(", ")}.`,
      });
    }

    if (quietMode !== undefined && typeof quietMode !== "boolean") {
      errors.push({
        field: "notifications.quietMode",
        message: `Invalid quietMode "${String(quietMode)}". Must be a boolean.`,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const STORE_PATH =
  process.env.SETTINGS_STORE_PATH ??
  path.join(process.cwd(), "data", "settings.json");

/** In-memory cache: userId → UserSettings */
const cache = new Map<string, UserSettings>();

let hydrated = false;

/**
 * Load persisted settings from disk into the in-memory cache.
 * Called once on first access (lazy hydration).
 */
function hydrateFromDisk(): void {
  if (hydrated) return;
  hydrated = true;

  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, UserSettings>;
    for (const [userId, settings] of Object.entries(parsed)) {
      cache.set(userId, settings);
    }
  } catch {
    // Corrupt or missing file — start with an empty cache.
  }
}

/**
 * Persist the current in-memory cache to disk asynchronously.
 * Errors are swallowed so a disk failure never crashes the process.
 */
function persistToDisk(): void {
  const snapshot = Object.fromEntries(cache.entries());
  const json = JSON.stringify(snapshot, null, 2);

  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFile(STORE_PATH, json, "utf8", () => {
    // Fire-and-forget — errors are intentionally ignored.
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve settings for a user.
 * Returns a deep clone of the defaults merged with any stored overrides.
 */
export function getSettings(userId: string): UserSettings {
  hydrateFromDisk();

  const stored = cache.get(userId);
  if (!stored) {
    return {
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications },
    };
  }

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      ...stored.notifications,
    },
    // Guard against legacy persisted records that predate versioning.
    version: typeof stored.version === "number" ? stored.version : 0,
  };
}

export type SettingsUpdateResult =
  | { settings: UserSettings }
  | { errors: ValidationError[] }
  | { conflict: true; current: UserSettings; expectedVersion: number };

export interface SettingsUpdateOptions {
  /**
   * The version the caller believes the preferences are at (from a prior
   * GET). When provided and out of date, the update is rejected with a
   * conflict instead of silently clobbering concurrent changes.
   */
  expectedVersion?: number;
  /** Optional audit source tag recorded in the change log (e.g. "api"). */
  source?: string;
  /** Optional actor id (admin/user) recorded in the change log. */
  actorId?: string;
}

/**
 * Apply a partial update to a user's settings.
 *
 * With `options.expectedVersion` set, the update is optimistic-concurrency
 * controlled: if the stored version differs from the expected one, a
 * `{ conflict: true, current }` result is returned instead of overwriting
 * the newer state. Callers can then surface the current settings and let
 * the user merge/retry via `resolveSettingsConflict`.
 *
 * @returns The updated settings, a list of validation errors, or a conflict.
 */
export function updateSettings(
  userId: string,
  patch: PartialUserSettings,
  options: SettingsUpdateOptions = {},
): SettingsUpdateResult {
  const errors = validateSettings(patch);
  if (errors.length > 0) {
    return { errors };
  }

  hydrateFromDisk();

  const current = getSettings(userId);

  if (
    options.expectedVersion !== undefined &&
    current.version !== options.expectedVersion
  ) {
    return {
      conflict: true,
      current,
      expectedVersion: options.expectedVersion,
    };
  }

  const previousVersion = current.version;
  const updated = applyPatch(current, patch);

  cache.set(userId, updated);
  persistToDisk();

  emitChangeEvent({
    userId,
    actorId: options.actorId ?? null,
    action: "update",
    previousVersion,
    newVersion: updated.version,
    changes: patch as unknown as Record<string, unknown>,
    source: options.source ?? "api",
  });

  return { settings: updated };
}

/**
 * Resolve a version conflict explicitly with a chosen strategy.
 *
 *   - "server-wins": discard the incoming patch, keep the stored settings.
 *   - "client-wins": apply the incoming patch over the stored settings.
 *   - "merge":       apply only the fields present in the patch, keeping
 *                    everything else from the stored settings.
 *
 * All strategies advance the version so the conflict is permanently
 * resolved (subsequent updates with the returned version succeed).
 */
export function resolveSettingsConflict(
  userId: string,
  patch: PartialUserSettings,
  strategy: ConflictResolutionStrategy,
  options: SettingsUpdateOptions = {},
): { settings: UserSettings } | { errors: ValidationError[] } {
  const errors = validateSettings(patch);
  if (errors.length > 0) {
    return { errors };
  }

  hydrateFromDisk();
  const current = getSettings(userId);
  const previousVersion = current.version;

  let updated: UserSettings;
  if (strategy === "server-wins") {
    updated = { ...current, version: current.version + 1 };
  } else {
    // "client-wins" and "merge" both layer the patch on top of the stored
    // state; the difference is that merge is applied field-by-field through
    // applyPatch (which is what updateSettings does anyway).
    updated = applyPatch(current, patch);
  }

  cache.set(userId, updated);
  persistToDisk();

  emitChangeEvent({
    userId,
    actorId: options.actorId ?? null,
    action: "update",
    previousVersion,
    newVersion: updated.version,
    changes: {
      ...(patch as unknown as Record<string, unknown>),
      _resolutionStrategy: strategy,
    },
    source: options.source ?? "api",
  });

  return { settings: updated };
}

export type ConflictResolutionStrategy =
  | "server-wins"
  | "client-wins"
  | "merge";

function applyPatch(
  current: UserSettings,
  patch: PartialUserSettings,
): UserSettings {
  // Normalise currency to uppercase before storing.
  const normalisedCurrency =
    patch.currency !== undefined
      ? (normaliseCurrency(patch.currency) ?? current.currency)
      : current.currency;

  return {
    theme: patch.theme ?? current.theme,
    currency: normalisedCurrency,
    notifications: {
      toastDensity:
        patch.notifications?.toastDensity ?? current.notifications.toastDensity,
      quietMode:
        patch.notifications?.quietMode ?? current.notifications.quietMode,
    },
    updatedAt: new Date().toISOString(),
    version: current.version + 1,
  };
}

/**
 * Reset a user's settings to the application defaults. The version is still
 * advanced so concurrent sessions that read the old version conflict.
 */
export function resetSettings(
  userId: string,
  options: SettingsUpdateOptions = {},
): UserSettings {
  hydrateFromDisk();
  const previousVersion = getSettings(userId).version;

  const defaults: UserSettings = {
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications },
    updatedAt: new Date().toISOString(),
    version: previousVersion + 1,
  };

  cache.set(userId, defaults);
  persistToDisk();

  emitChangeEvent({
    userId,
    actorId: options.actorId ?? null,
    action: "reset",
    previousVersion,
    newVersion: defaults.version,
    changes: { reset: true },
    source: options.source ?? "api",
  });

  return defaults;
}

/**
 * Remove all settings for a user (e.g. on account deletion).
 */
export function deleteSettings(
  userId: string,
  options: SettingsUpdateOptions = {},
): void {
  hydrateFromDisk();
  const previousVersion = getSettings(userId).version;
  cache.delete(userId);
  persistToDisk();

  emitChangeEvent({
    userId,
    actorId: options.actorId ?? null,
    action: "delete",
    previousVersion,
    newVersion: previousVersion,
    changes: { deleted: true },
    source: options.source ?? "api",
  });
}

// ---------------------------------------------------------------------------
// Change events (audit trail + webhook notifications)
// ---------------------------------------------------------------------------

export interface SettingsChangeEvent {
  userId: string;
  actorId: string | null;
  action: "update" | "reset" | "delete";
  previousVersion: number;
  newVersion: number;
  changes: Record<string, unknown>;
  source: string;
}

/** Registered listeners are invoked (synchronously) after each mutation. */
type SettingsChangeListener = (event: SettingsChangeEvent) => void;

const changeListeners = new Set<SettingsChangeListener>();

/**
 * Register a listener invoked after every settings mutation. Used by the
 * API layer to write the audit trail and enqueue change webhooks.
 * Returns an unsubscribe function.
 */
export function onSettingsChanged(
  listener: SettingsChangeListener,
): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitChangeEvent(event: SettingsChangeEvent): void {
  for (const listener of changeListeners) {
    try {
      listener(event);
    } catch {
      // A failing listener must never break the settings mutation itself.
    }
  }
}

/**
 * Expose the valid option sets for client-side rendering of the panel.
 */
export const SETTINGS_OPTIONS = Object.freeze({
  themes: [...VALID_THEMES] as Theme[],
  toastDensities: [...VALID_TOAST_DENSITIES] as ToastDensity[],
});

/**
 * Reset the in-memory cache, hydration flag and change listeners.
 * Intended for use in tests only.
 */
export function _resetStoreForTesting(): void {
  cache.clear();
  hydrated = false;
  changeListeners.clear();
}
