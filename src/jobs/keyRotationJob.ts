/**
 * Scheduled encryption-key rotation watcher.
 *
 * AES key material itself lives in the secret manager / environment, so this
 * job never generates keys. Instead it automates the rotation workflow:
 *
 *  1. Validates the configured key ring (active version must exist).
 *  2. Detects a rotation: either `ACTIVE_PII_KEY_VERSION` changed since the last
 *     run, or the configured interval elapsed without a new version.
 *  3. When a new version is active, runs the re-encryption sweep
 *     (`src/scripts/rotate-encryption-keys.ts`) so existing rows move to the
 *     new key. Set `ENCRYPTION_KEY_AUTO_MIGRATE=true` to also sweep when only
 *     the interval elapsed.
 *  4. Persists the last rotation timestamp so the interval is stable across
 *     restarts (Redis when available, in-memory otherwise).
 *
 * Configuration (env vars):
 *   ENCRYPTION_KEY_ROTATION_INTERVAL_DAYS  days between rotations (default 90)
 *   ENCRYPTION_KEY_AUTO_MIGRATE            "true" to sweep on interval expiry
 */

import { redisClient } from "../config/redis";
import {
  getActiveKeyVersion,
  getKeyRing,
  validateKeyRingConfig,
} from "../crypto/encryption";

export interface KeyRotationState {
  lastRotatedAt: string | null;
  lastActiveVersion: string | null;
}

export interface KeyRotationStateStore {
  get(): Promise<KeyRotationState | null>;
  set(state: KeyRotationState): Promise<void>;
}

export interface KeyRotationMigrationSummary {
  scanned: number;
  rotated: number;
  failed: number;
}

export interface EncryptionKeyRotationJobResult {
  executed: boolean;
  reason: string;
  activeVersion: string;
  keyVersions: string[];
  intervalDays: number;
  nextRotationDueAt: string | null;
  migration: KeyRotationMigrationSummary | null;
}

export interface EncryptionKeyRotationJobOptions {
  now?: Date;
  intervalDays?: number;
  autoMigrate?: boolean;
  stateStore?: KeyRotationStateStore;
  migrate?: (targetVersion: string) => Promise<KeyRotationMigrationSummary>;
}

export const KEY_ROTATION_STATE_KEY = "encryption:key-rotation:state";
export const DEFAULT_ROTATION_INTERVAL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

let memoryState: KeyRotationState | null = null;

/** Redis-backed state store with an in-memory fallback. */
export const redisKeyRotationStateStore: KeyRotationStateStore = {
  async get(): Promise<KeyRotationState | null> {
    try {
      if (redisClient.isOpen) {
        const raw = await redisClient.get(KEY_ROTATION_STATE_KEY);
        if (raw) return JSON.parse(raw) as KeyRotationState;
      }
    } catch (err) {
      console.warn(
        "[encryption-key-rotation] Failed to read rotation state from Redis",
        err,
      );
    }
    return memoryState;
  },

  async set(state: KeyRotationState): Promise<void> {
    memoryState = state;
    try {
      if (redisClient.isOpen) {
        await redisClient.set(KEY_ROTATION_STATE_KEY, JSON.stringify(state));
      }
    } catch (err) {
      console.warn(
        "[encryption-key-rotation] Failed to persist rotation state to Redis",
        err,
      );
    }
  },
};

/** Clears the in-memory rotation state — used by tests. */
export function resetEncryptionKeyRotationState(): void {
  memoryState = null;
}

export function resolveRotationIntervalDays(): number {
  const parsed = Number.parseInt(
    process.env.ENCRYPTION_KEY_ROTATION_INTERVAL_DAYS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ROTATION_INTERVAL_DAYS;
}

async function defaultMigrate(
  targetVersion: string,
): Promise<KeyRotationMigrationSummary> {
  const { rotateEncryptionKeys } =
    await import("../scripts/rotate-encryption-keys");
  const summary = await rotateEncryptionKeys({ targetVersion });
  return {
    scanned: summary.totalScanned,
    rotated: summary.totalRotated,
    failed: summary.totalFailed,
  };
}

/**
 * Runs the rotation check. Safe to call repeatedly — it is a no-op until a new
 * key version is active or the interval elapses.
 */
export async function runEncryptionKeyRotationJob(
  options: EncryptionKeyRotationJobOptions = {},
): Promise<EncryptionKeyRotationJobResult> {
  const now = options.now ?? new Date();
  const intervalDays = options.intervalDays ?? resolveRotationIntervalDays();
  const stateStore = options.stateStore ?? redisKeyRotationStateStore;
  const autoMigrate =
    options.autoMigrate ?? process.env.ENCRYPTION_KEY_AUTO_MIGRATE === "true";
  const migrate = options.migrate ?? defaultMigrate;

  const ring = getKeyRing();
  const activeVersion = getActiveKeyVersion(ring);
  const keyVersions = Array.from(ring.keys());
  const config = validateKeyRingConfig(ring);

  if (!config.valid) {
    console.error(
      `[encryption-key-rotation] Invalid key ring configuration: ${config.errors.join("; ")}`,
    );
    return {
      executed: false,
      reason: "invalid-key-ring-config",
      activeVersion,
      keyVersions,
      intervalDays,
      nextRotationDueAt: null,
      migration: null,
    };
  }

  for (const warning of config.warnings) {
    console.warn(`[encryption-key-rotation] ${warning}`);
  }

  const state = await stateStore.get();
  const lastRotatedAt = state?.lastRotatedAt ?? null;
  const lastActiveVersion = state?.lastActiveVersion ?? null;

  const dueAt = lastRotatedAt
    ? new Date(lastRotatedAt).getTime() + intervalDays * DAY_MS
    : now.getTime();
  const versionChanged =
    lastActiveVersion !== null && lastActiveVersion !== activeVersion;

  if (!versionChanged && now.getTime() < dueAt) {
    return {
      executed: false,
      reason: "not-due",
      activeVersion,
      keyVersions,
      intervalDays,
      nextRotationDueAt: new Date(dueAt).toISOString(),
      migration: null,
    };
  }

  const reason = versionChanged
    ? "active-key-version-changed"
    : "rotation-interval-elapsed";
  const shouldMigrate = versionChanged || autoMigrate;
  let migration: KeyRotationMigrationSummary | null = null;

  if (shouldMigrate) {
    try {
      migration = await migrate(activeVersion);
    } catch (error) {
      console.error(
        "[encryption-key-rotation] Re-encryption sweep failed",
        error,
      );
      return {
        executed: false,
        reason: "migration-failed",
        activeVersion,
        keyVersions,
        intervalDays,
        nextRotationDueAt: new Date(dueAt).toISOString(),
        migration: null,
      };
    }
  } else {
    console.warn(
      `[encryption-key-rotation] Rotation due (${reason}) but ENCRYPTION_KEY_AUTO_MIGRATE is not "true"; skipping the re-encryption sweep.`,
    );
  }

  await stateStore.set({
    lastRotatedAt: now.toISOString(),
    lastActiveVersion: activeVersion,
  });

  return {
    executed: true,
    reason,
    activeVersion,
    keyVersions,
    intervalDays,
    nextRotationDueAt: new Date(
      now.getTime() + intervalDays * DAY_MS,
    ).toISOString(),
    migration,
  };
}

export default runEncryptionKeyRotationJob;
