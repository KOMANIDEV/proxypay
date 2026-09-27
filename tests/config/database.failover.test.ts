/**
 * Failover / DR test coverage for the database layer (src/config/database.ts).
 *
 * These tests exercise the replication & failover behaviour with a mocked `pg`
 * module so no real database is needed:
 *   - read queries route to replicas and fall back to the primary on failure
 *   - replicas above the lag threshold are disabled and reads fall back
 *   - round-robin load balancing across multiple replicas
 *   - checkReplicaHealth / getReplicationStatus report health, lag and DR mode
 *   - getPoolStats reports failover mode when DR_DATABASE_URL is set
 *   - querySmart routes SELECT to replicas and writes to the primary
 */

jest.mock("pg", () => {
  class MockPool {
    static instances: MockPool[] = [];

    connectionString: string | undefined;
    healthy = true;
    lagSeconds: number | null = 0;
    query: jest.Mock;
    connect: jest.Mock;

    constructor(options: any = {}) {
      this.connectionString = options?.connectionString;
      this.query = jest.fn().mockResolvedValue({ rows: [] });
      this.connect = jest.fn(() => {
        if (!this.healthy) {
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        const client = {
          query: jest.fn((text: string) => {
            if (String(text).includes("pg_is_in_recovery")) {
              return Promise.resolve({
                rows: [{ lag_seconds: this.lagSeconds }],
              });
            }
            return Promise.resolve({ rows: [{ ok: true, text }] });
          }),
          release: jest.fn(),
        };
        return Promise.resolve(client);
      });
      MockPool.instances.push(this);
    }

    async end(): Promise<void> {}
  }

  return { Pool: MockPool };
});

const { Pool: MockPool } = require("pg") as {
  Pool: {
    instances: Array<{
      connectionString?: string;
      healthy: boolean;
      lagSeconds: number | null;
      query: jest.Mock;
      connect: jest.Mock;
    }>;
  };
};

const DATABASE_URL = "postgresql://user:pass@primary:5432/proxypay_stellar";
const REPLICA_1 = "postgresql://user:pass@replica1:5432/proxypay_stellar";
const REPLICA_2 = "postgresql://user:pass@replica2:5432/proxypay_stellar";

const flush = () => new Promise((resolve) => setImmediate(resolve));

interface LoadedDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Loads a fresh instance of src/config/database.ts with the given env overrides
 * and a clean pg pool registry. instances[0] is the primary pool; the rest are
 * the replicas in READ_REPLICA_URL order.
 */
function loadDatabase(
  overrides: Record<string, string | undefined>,
): { db: LoadedDatabase; pools: typeof MockPool.instances } {
  jest.resetModules();

  // `jest.resetModules()` re-applies the pg mock factory, which creates a fresh
  // MockPool class — so re-require pg here to get the live class and its static
  // instance registry.
  const freshPg = require("pg") as {
    Pool: { instances: typeof MockPool.instances };
  };
  freshPg.Pool.instances.length = 0;

  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key] as string;
    }
  }

  const db = require("../../src/config/database");

  // NOTE: env overrides are intentionally left in place for the duration of the
  // test — getPoolStats() reads process.env.DATABASE_URL / DR_DATABASE_URL at
  // call time, not just at module load. afterEach() restores them.
  return { db, pools: freshPg.Pool.instances };
}

describe("database failover / replication", () => {
  afterEach(() => {
    delete process.env.READ_REPLICA_URL;
    delete process.env.DR_DATABASE_URL;
    delete process.env.REPLICA_SYNC_LAG_THRESHOLD_SECONDS;
    delete process.env.REPLICA_LAG_MONITOR_INTERVAL_MS;
    process.env.DATABASE_URL =
      "postgresql://test_user:test_password@localhost:5432/test_db";
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe("queryRead", () => {
    it("routes reads to a healthy replica", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
      });
      const replica = pools[1];
      replica.lagSeconds = 1; // within the 5s threshold
      replica.healthy = true;

      await flush();
      await flush();

      const result = await db.queryRead("SELECT 1");

      expect(replica.connect).toHaveBeenCalled();
      // The replica's client.query answers with rows; the primary pool's query
      // mock returns { rows: [] } — so non-empty rows prove the replica served it.
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("falls back to the primary when the replica connection fails", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
      });
      const replica = pools[1];
      replica.healthy = false;

      await flush();
      await flush();

      const result = await db.queryRead("SELECT 1");

      // Primary pool query answered with { rows: [] } — non-empty rows would
      // indicate the replica served it.
      expect(result.rows).toEqual([]);
    });

    it("disables a lagging replica and falls back to the primary", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
        REPLICA_SYNC_LAG_THRESHOLD_SECONDS: "5",
      });
      pools[1].lagSeconds = 60; // far beyond threshold

      await flush();
      await flush();

      const result = await db.queryRead("SELECT 1");

      expect(result.rows).toEqual([]);
    });

    it("round-robins across multiple replicas", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: `${REPLICA_1},${REPLICA_2}`,
        DR_DATABASE_URL: undefined,
      });
      const [primary, replicaA, replicaB] = pools;
      primary.connect.mockClear();
      replicaA.connect.mockClear();
      replicaB.connect.mockClear();

      await flush();
      await flush();

      await db.queryRead("SELECT 1");
      await db.queryRead("SELECT 2");

      expect(replicaA.connect).toHaveBeenCalledTimes(1);
      expect(replicaB.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe("checkReplicaHealth", () => {
    it("reports healthy replicas with their lag", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
      });
      pools[1].lagSeconds = 2.5;

      const health = await db.checkReplicaHealth();

      expect(health).toEqual([
        {
          url: REPLICA_1,
          healthy: true,
          enabled: true,
          lagSeconds: 2.5,
        },
      ]);
    });

    it("reports unhealthy replicas and disables them", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
      });
      pools[1].healthy = false;

      const health = await db.checkReplicaHealth();

      expect(health[0].healthy).toBe(false);
      expect(health[0].enabled).toBe(false);
      expect(health[0].lagSeconds).toBeNull();
    });
  });

  describe("getReplicationStatus", () => {
    it("returns ok/standby when replicas are healthy and no DR is configured", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
      });
      pools[1].lagSeconds = 1;

      const status = await db.getReplicationStatus();

      expect(status.status).toBe("ok");
      expect(status.drMode).toBe("standby");
      expect(status.replicas).toHaveLength(1);
    });

    it("returns degraded when a replica is lagging", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
      });
      pools[1].lagSeconds = 60;

      const status = await db.getReplicationStatus();

      expect(status.status).toBe("degraded");
      expect(status.lagThresholdSeconds).toBe(5);
    });

    it("returns active DR mode when DR_DATABASE_URL is configured", async () => {
      const { db } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: undefined,
        DR_DATABASE_URL: "postgresql://user:pass@dr-region:5432/proxypay_stellar",
      });

      const status = await db.getReplicationStatus();

      expect(status.drMode).toBe("active");
    });
  });

  describe("getPoolStats", () => {
    it("reports failover mode and DR url when DR_DATABASE_URL is set", async () => {
      const drUrl = "postgresql://user:pass@dr-region:5432/proxypay_stellar";
      const { db } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: undefined,
        DR_DATABASE_URL: drUrl,
      });

      const stats = await db.getPoolStats();

      expect(stats.primary.mode).toBe("failover");
      expect(stats.primary.url).toBe(drUrl);
      expect(stats.primary.description).toContain("failover");
    });

    it("reports normal mode when no DR is configured", async () => {
      const { db } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: undefined,
        DR_DATABASE_URL: undefined,
      });

      const stats = await db.getPoolStats();

      expect(stats.primary.mode).toBe("normal");
      expect(stats.primary.url).toBe(DATABASE_URL);
    });
  });

  describe("querySmart", () => {
    it("routes SELECT queries to the replica", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
      });
      const replica = pools[1];
      replica.lagSeconds = 0;

      await flush();
      await flush();

      const result = await db.querySmart("SELECT * FROM users WHERE id = $1", [1]);

      expect(replica.connect).toHaveBeenCalled();
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("routes write queries to the primary", async () => {
      const { db, pools } = loadDatabase({
        DATABASE_URL,
        READ_REPLICA_URL: REPLICA_1,
        DR_DATABASE_URL: undefined,
      });
      pools[1].lagSeconds = 0;

      await flush();
      await flush();

      const result = await db.querySmart(
        "INSERT INTO users (name) VALUES ($1)",
        ["ada"],
      );

      // The primary answers with { rows: [] }; a replica answer would carry rows.
      expect(result.rows).toEqual([]);
    });
  });
});
