import { describe, expect, it, afterEach, jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import type { Pool } from "pg";
import { MigrationRunner } from "../../src/migrations/runner";

const tmpDirs: string[] = [];

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-runner-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class FakeClient {
  queries: string[] = [];
  query = jest.fn(async (text: string) => {
    this.queries.push(text);
    return { rows: [] };
  });
  release = jest.fn();
}

class FakePool {
  queries: string[] = [];
  results: Record<string, { rows: unknown[] }> = {};
  clients: FakeClient[] = [];
  connect = jest.fn(async () => {
    const client = new FakeClient();
    this.clients.push(client);
    return client;
  });
  query = jest.fn(async (text: string) => {
    this.queries.push(text);
    for (const [prefix, result] of Object.entries(this.results)) {
      if (text.startsWith(prefix)) return result;
    }
    return { rows: [] };
  });
}

function makeRunner(dir: string, pool: FakePool): MigrationRunner {
  return new MigrationRunner({
    pool: pool as unknown as Pool,
    migrationsDir: dir,
    log: () => {},
  });
}

const validMigrations = {
  "001_create_users.sql": "CREATE TABLE users (id INT PRIMARY KEY);",
  "001_create_users.down.sql": "DROP TABLE users;",
  "002_add_email.sql": "ALTER TABLE users ADD COLUMN email TEXT;",
  "002_add_email.down.sql": "ALTER TABLE users DROP COLUMN email;",
};

describe("MigrationRunner.up", () => {
  it("applies pending migrations in order and records versions", async () => {
    const dir = makeDir(validMigrations);
    const pool = new FakePool();
    const runner = makeRunner(dir, pool);

    const result = await runner.up();

    expect(result.applied.map((m) => m.name)).toEqual([
      "001_create_users.sql",
      "002_add_email.sql",
    ]);
    const insertCalls = pool.clients.flatMap((c) => c.queries).filter((q) =>
      q.startsWith("INSERT INTO schema_migrations"),
    );
    expect(insertCalls).toHaveLength(2);
    // Each migration ran inside its own BEGIN/COMMIT.
    const clientQueries = pool.clients.flatMap((c) => c.queries);
    expect(clientQueries.filter((q) => q === "BEGIN")).toHaveLength(2);
    expect(clientQueries.filter((q) => q === "COMMIT")).toHaveLength(2);
  });

  it("applies nothing in dry-run mode: single transaction, one rollback", async () => {
    const dir = makeDir(validMigrations);
    const pool = new FakePool();
    const runner = makeRunner(dir, pool);

    const result = await runner.up({ dryRun: true });

    expect(result.applied).toHaveLength(2);
    // The whole chain runs in ONE transaction so later migrations see the
    // schema of earlier ones, then a single ROLLBACK discards everything.
    expect(pool.clients).toHaveLength(1);
    const clientQueries = pool.clients[0].queries;
    expect(clientQueries.filter((q) => q === "BEGIN")).toHaveLength(1);
    expect(clientQueries.filter((q) => q === "ROLLBACK")).toHaveLength(1);
    expect(clientQueries.some((q) => q.startsWith("INSERT INTO schema_migrations"))).toBe(
      false,
    );
    expect(clientQueries.some((q) => q === "COMMIT")).toBe(false);
    // Both migration bodies were executed.
    expect(clientQueries).toContain("CREATE TABLE users (id INT PRIMARY KEY);");
    expect(clientQueries).toContain("ALTER TABLE users ADD COLUMN email TEXT;");
  });

  it("reports no pending migrations when everything is applied", async () => {
    const dir = makeDir(validMigrations);
    const pool = new FakePool();
    pool.results["SELECT version FROM schema_migrations ORDER BY version"] = {
      rows: [{ version: "001_create_users" }, { version: "002_add_email" }],
    };
    const runner = makeRunner(dir, pool);

    const result = await runner.up();
    expect(result.applied).toEqual([]);
  });

  it("refuses to run when a pending migration is missing a rollback file", async () => {
    const dir = makeDir({
      "001_create_users.sql": "CREATE TABLE users (id INT);",
    });
    const pool = new FakePool();
    const runner = makeRunner(dir, pool);

    await expect(runner.up()).rejects.toThrow(/missing rollback file/i);
  });

  it("refuses to run when validation finds errors", async () => {
    const dir = makeDir({
      "001_broken.sql": "CREATE TABLE users (id INT); /* unterminated",
      "001_broken.down.sql": "DROP TABLE users;",
    });
    const pool = new FakePool();
    const runner = makeRunner(dir, pool);

    await expect(runner.up()).rejects.toThrow(/validation failed/i);
    // Nothing was applied.
    expect(pool.clients).toHaveLength(0);
  });

  it("can bypass validation with skipValidation", async () => {
    const dir = makeDir({
      "001_broken.sql": "SELECT 1; /* unterminated",
      "001_broken.down.sql": "DROP TABLE users;",
    });
    const pool = new FakePool();
    const runner = makeRunner(dir, pool);

    // Validation would fail, but with skipValidation the runner proceeds to
    // execute (the mock pool accepts anything).
    const result = await runner.up({ skipValidation: true });
    expect(result.applied).toHaveLength(1);
  });

  it("releases clients and rolls back on a failed migration", async () => {
    const dir = makeDir({
      "001_ok.sql": "CREATE TABLE users (id INT);",
      "001_ok.down.sql": "DROP TABLE users;",
      "002_fails.sql": "THIS IS NOT SQL;",
      "002_fails.down.sql": "SELECT 1;",
    });
    const pool = new FakePool();
    const runner = makeRunner(dir, pool);
    // First client (migration 001) succeeds, second (002) fails.
    pool.connect.mockImplementation(async () => {
      const client = new FakeClient();
      if (pool.clients.length === 1) {
        client.query.mockImplementation(async (text: string) => {
          client.queries.push(text);
          // The file content is "THIS IS NOT SQL;" — match on the statement
          // body so the mock fails exactly where the runner executes it.
          if (text.includes("THIS IS NOT SQL")) throw new Error("syntax error");
          return { rows: [] };
        });
      }
      pool.clients.push(client);
      return client;
    });

    await expect(runner.up()).rejects.toThrow(/syntax error/);

    const failed = pool.clients[1];
    expect(failed.queries).toContain("ROLLBACK");
    expect(failed.release).toHaveBeenCalled();
  });
});

describe("MigrationRunner.down", () => {
  it("rolls back the most recently applied migration and deletes its version", async () => {
    const dir = makeDir(validMigrations);
    const pool = new FakePool();
    pool.results[
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
    ] = { rows: [{ version: "002_add_email" }] };
    const runner = makeRunner(dir, pool);

    const rolledBack = await runner.down();

    expect(rolledBack?.name).toBe("002_add_email.sql");
    const clientQueries = pool.clients.flatMap((c) => c.queries);
    expect(clientQueries).toContain("ALTER TABLE users DROP COLUMN email;");
    expect(clientQueries).toContain(
      "DELETE FROM schema_migrations WHERE version = $1",
    );
  });

  it("returns null when nothing is applied", async () => {
    const dir = makeDir(validMigrations);
    const pool = new FakePool();
    const runner = makeRunner(dir, pool);

    await expect(runner.down()).resolves.toBeNull();
  });

  it("throws when the applied version has no migration file", async () => {
    const dir = makeDir(validMigrations);
    const pool = new FakePool();
    pool.results[
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
    ] = { rows: [{ version: "999_unknown" }] };
    const runner = makeRunner(dir, pool);

    await expect(runner.down()).rejects.toThrow(/Could not find migration file/);
  });

  it("throws when the last migration has no rollback file", async () => {
    const dir = makeDir({
      "001_create_users.sql": "CREATE TABLE users (id INT);",
    });
    const pool = new FakePool();
    pool.results[
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
    ] = { rows: [{ version: "001_create_users" }] };
    const runner = makeRunner(dir, pool);

    await expect(runner.down()).rejects.toThrow(/No rollback file found/);
  });
});

describe("MigrationRunner.status", () => {
  it("reports applied and pending migrations", async () => {
    const dir = makeDir(validMigrations);
    const pool = new FakePool();
    pool.results["SELECT version, applied_at FROM schema_migrations ORDER BY version"] =
      {
        rows: [
          { version: "001_create_users", applied_at: "2026-01-01T00:00:00.000Z" },
        ],
      };
    const runner = makeRunner(dir, pool);

    const rows = await runner.status();
    expect(rows).toEqual([
      {
        version: "001_create_users",
        name: "001_create_users.sql",
        status: "applied",
        appliedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        version: "002_add_email",
        name: "002_add_email.sql",
        status: "pending",
        appliedAt: null,
      },
    ]);
  });
});

describe("MigrationRunner.normalizeLegacyAppliedVersions", () => {
  it("rewrites legacy numeric versions to full identifiers", async () => {
    const dir = makeDir(validMigrations);
    const pool = new FakePool();
    pool.results["SELECT version FROM schema_migrations WHERE version ~ '^[0-9]+$'"] =
      { rows: [{ version: "001" }, { version: "002" }] };
    // Only 001 has a legacy row to normalize; 002 is already applied under its
    // full name, so its legacy row is deleted instead.
    pool.results["SELECT version FROM schema_migrations ORDER BY version"] = {
      rows: [{ version: "002_add_email" }],
    };
    const runner = makeRunner(dir, pool);

    await runner.normalizeLegacyAppliedVersions(runner.discover());

    const update = pool.queries.find((q) => q.startsWith("UPDATE schema_migrations"));
    expect(update).toBeDefined();
    const deleteCalls = pool.queries.filter((q) =>
      q.startsWith("DELETE FROM schema_migrations"),
    );
    expect(deleteCalls).toHaveLength(1);
  });
});
