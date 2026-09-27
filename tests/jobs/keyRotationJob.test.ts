jest.mock("../../src/config/redis", () => ({
  redisClient: {
    isOpen: false,
    get: jest.fn(),
    set: jest.fn(),
  },
}));

import {
  runEncryptionKeyRotationJob,
  DEFAULT_ROTATION_INTERVAL_DAYS,
  type KeyRotationState,
  type KeyRotationStateStore,
} from "../../src/jobs/keyRotationJob";

const ORIGINAL_ENV = { ...process.env };
const KEY_V1 = "rotation-job-key-v1-material-32ch";
const KEY_V2 = "rotation-job-key-v2-material-32ch";

function createStateStore(
  initial: KeyRotationState | null = null,
): KeyRotationStateStore & {
  state: KeyRotationState | null;
} {
  const store = {
    state: initial,
    get: jest.fn(async () => store.state),
    set: jest.fn(async (next: KeyRotationState) => {
      store.state = next;
    }),
  };
  return store as KeyRotationStateStore & { state: KeyRotationState | null };
}

describe("encryption key rotation job", () => {
  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEYS = JSON.stringify({
      v1: KEY_V1,
      v2: KEY_V2,
    });
    process.env.ACTIVE_PII_KEY_VERSION = "v2";
    delete process.env.ENCRYPTION_KEY_ROTATION_INTERVAL_DAYS;
    delete process.env.ENCRYPTION_KEY_AUTO_MIGRATE;
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("records a baseline on the first run and is a no-op before the interval", async () => {
    const store = createStateStore();
    const firstRun = new Date("2026-01-01T00:00:00Z");

    const first = await runEncryptionKeyRotationJob({
      now: firstRun,
      intervalDays: 90,
      stateStore: store,
    });

    expect(first.executed).toBe(true);
    expect(first.reason).toBe("rotation-interval-elapsed");
    expect(first.activeVersion).toBe("v2");
    expect(store.state?.lastActiveVersion).toBe("v2");

    const second = await runEncryptionKeyRotationJob({
      now: new Date("2026-02-01T00:00:00Z"),
      intervalDays: 90,
      stateStore: store,
    });

    expect(second.executed).toBe(false);
    expect(second.reason).toBe("not-due");
    expect(second.nextRotationDueAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("runs the re-encryption sweep when the active key version changes", async () => {
    const store = createStateStore({
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
      lastActiveVersion: "v1",
    });
    const migrate = jest.fn(async () => ({
      scanned: 10,
      rotated: 10,
      failed: 0,
    }));

    const result = await runEncryptionKeyRotationJob({
      now: new Date("2026-01-02T00:00:00Z"),
      intervalDays: 90,
      stateStore: store,
      migrate,
    });

    expect(result.executed).toBe(true);
    expect(result.reason).toBe("active-key-version-changed");
    expect(migrate).toHaveBeenCalledWith("v2");
    expect(result.migration).toEqual({ scanned: 10, rotated: 10, failed: 0 });
    expect(store.state?.lastActiveVersion).toBe("v2");
  });

  it("skips the sweep on interval expiry unless auto-migration is enabled", async () => {
    const store = createStateStore({
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
      lastActiveVersion: "v2",
    });
    const migrate = jest.fn(async () => ({
      scanned: 1,
      rotated: 1,
      failed: 0,
    }));

    const withoutAuto = await runEncryptionKeyRotationJob({
      now: new Date("2026-06-01T00:00:00Z"),
      intervalDays: 90,
      stateStore: store,
      migrate,
    });

    expect(withoutAuto.reason).toBe("rotation-interval-elapsed");
    expect(withoutAuto.migration).toBeNull();
    expect(migrate).not.toHaveBeenCalled();

    const withAuto = await runEncryptionKeyRotationJob({
      now: new Date("2026-06-01T00:00:00Z"),
      intervalDays: 90,
      autoMigrate: true,
      stateStore: createStateStore({
        lastRotatedAt: "2026-01-01T00:00:00.000Z",
        lastActiveVersion: "v2",
      }),
      migrate,
    });

    expect(withAuto.migration).not.toBeNull();
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it("reports an invalid key ring without executing", async () => {
    delete process.env.PII_ENCRYPTION_KEYS;
    delete process.env.PII_ENCRYPTION_KEY;
    delete process.env.DB_ENCRYPTION_KEY;
    delete process.env.ACTIVE_PII_KEY_VERSION;

    const result = await runEncryptionKeyRotationJob({
      now: new Date(),
      stateStore: createStateStore(),
    });

    expect(result.executed).toBe(false);
    expect(result.reason).toBe("invalid-key-ring-config");
  });

  it("does not advance state when the sweep fails so it retries next run", async () => {
    const store = createStateStore({
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
      lastActiveVersion: "v1",
    });

    const result = await runEncryptionKeyRotationJob({
      now: new Date("2026-01-02T00:00:00Z"),
      stateStore: store,
      migrate: jest.fn(async () => {
        throw new Error("db down");
      }),
    });

    expect(result.executed).toBe(false);
    expect(result.reason).toBe("migration-failed");
    expect(store.state?.lastActiveVersion).toBe("v1");
  });

  it("resolves the default rotation interval", () => {
    expect(DEFAULT_ROTATION_INTERVAL_DAYS).toBe(90);
  });
});
