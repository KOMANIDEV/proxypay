/**
 * Migration integration tests.
 *
 * These tests run the REAL migration files against a REAL PostgreSQL database
 * (DATABASE_URL, defaulting to postgresql://test_user:test_password@localhost:
 * 5432/test_db — the same instance CI spins up). They are excluded from the
 * default unit-test suite (see jest.config.js) and run via:
 *
 *   npm run test:migrations
 *
 * The suite owns the `public` schema: it drops and recreates it, so it is safe
 * to run against a shared CI database, and it must not run in parallel with
 * other DB-touching tests (the jest config forces maxWorkers=1).
 */

import { describe, expect, it, beforeAll, afterAll } from "@jest/globals";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { MigrationRunner } from "../../../src/migrations/runner";

// tests/migrations/integration -> project root -> migrations
const migrationsDir = path.resolve(__dirname, "..", "..", "..", "migrations");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
});

const runMigrations = async (sql: string): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const applyOne = async (upPath: string, version: string): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(fs.readFileSync(upPath, "utf-8"));
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
      version,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const rollbackOne = async (downPath: string, version: string): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(fs.readFileSync(downPath, "utf-8"));
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [
      version,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

async function resetSchema(): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

/**
 * Capture the full structural state of the `public` schema: tables, columns,
 * constraints, indexes, enums, sequences, views, functions and triggers.
 * Comparing two snapshots verifies that a rollback restores the schema to
 * exactly its previous state.
 */
async function snapshotSchema(): Promise<string> {
  const queries = [
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
            character_maximum_length, numeric_precision, numeric_scale, datetime_precision
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`,
    `SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' ORDER BY 1, 2, 3`,
    "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2",
    `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' ORDER BY 1, 2`,
    "SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' ORDER BY 1",
    "SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY 1",
    `SELECT p.proname || '(' || COALESCE(pg_get_function_identity_arguments(p.oid), '') || ')'
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' ORDER BY 1`,
    `SELECT pg_get_functiondef(p.oid)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' ORDER BY 1`,
    `SELECT tgname, tgrelid::regclass::text AS tbl
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public' ORDER BY 1, 2`,
  ];
  const parts: string[] = [];
  for (const query of queries) {
    const result = await pool.query(query);
    if (query.includes("pg_get_functiondef")) {
      // Normalize whitespace: function bodies are stored verbatim, so a
      // formatting-only difference (e.g. trailing spaces) must not count as a
      // schema change.
      parts.push(
        JSON.stringify(
          result.rows.map((r: { pg_get_functiondef: string }) =>
            Object.values(r).map((v) => String(v).replace(/\s+/g, " ")),
          ),
        ),
      );
    } else {
      parts.push(JSON.stringify(result.rows));
    }
  }
  return parts.join("\n");
}

// Ends the shared pool once the WHOLE suite (both describe blocks) is done.
afterAll(async () => {
  await pool.end();
});

describe("migration runner (integration)", () => {
  beforeAll(async () => {
    await resetSchema();
  });

  it("dry-run verifies every migration applies without persisting anything", async () => {
    await resetSchema();
    const runner = new MigrationRunner({ pool, migrationsDir });

    const result = await runner.up({ dryRun: true });
    expect(result.applied.length).toBeGreaterThan(0);

    // Nothing persisted: no versions recorded, no user tables created.
    const applied = await runner.getAppliedVersions();
    expect(applied.size).toBe(0);

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`,
    );
    expect(tables.rows).toEqual([]);
  });

  it("up applies every migration", async () => {
    await resetSchema();
    const runner = new MigrationRunner({ pool, migrationsDir });

    const result = await runner.up();
    expect(result.applied.length).toBeGreaterThan(0);

    const applied = await runner.getAppliedVersions();
    const all = runner.discover();
    expect(applied.size).toBe(all.length);
  });

  it("status reports every migration as applied after a full run", async () => {
    const runner = new MigrationRunner({ pool, migrationsDir });
    const rows = await runner.status();
    expect(rows.length).toBe(runner.discover().length);
    expect(rows.every((r) => r.status === "applied")).toBe(true);
    expect(rows.every((r) => r.appliedAt !== null)).toBe(true);
  });

  it("up with nothing pending is a no-op", async () => {
    const runner = new MigrationRunner({ pool, migrationsDir });
    const result = await runner.up();
    expect(result.applied).toEqual([]);
  });

  it("down rolls back the last migration and up reapplies it", async () => {
    const runner = new MigrationRunner({ pool, migrationsDir });

    const before = (await runner.status()).filter((r) => r.status === "applied");
    const last = before[before.length - 1];
    expect(last).toBeDefined();

    const rolledBack = await runner.down();
    expect(rolledBack?.version).toBe(last.version);

    const afterDown = await runner.getAppliedVersions();
    expect(afterDown.has(last.version)).toBe(false);

    // And it can be re-applied.
    await runner.up();
    const afterUp = await runner.getAppliedVersions();
    expect(afterUp.has(last.version)).toBe(true);
  });

  it("static validation passes on the real migration set", () => {
    const runner = new MigrationRunner({ pool, migrationsDir });
    const result = runner.validate();
    expect(result.errors).toEqual([]);
  });
});

describe("rollback verification for every migration", () => {
  beforeAll(async () => {
    await resetSchema();
  });

  it(
    "each migration's down file restores the exact previous schema state",
    async () => {
      const runner = new MigrationRunner({ pool, migrationsDir });
      await runner.ensureMigrationsTable();

      const migrations = runner.discover();
      expect(migrations.length).toBeGreaterThan(0);

      const skipped: string[] = [];

      const noOps: string[] = [];

      for (let i = 0; i < migrations.length; i++) {
        const migration = migrations[i];
        const before = await snapshotSchema();

        await applyOne(migration.upPath, migration.version);

        if (!migration.downPath) {
          skipped.push(migration.name);
          continue;
        }

        const afterUp = await snapshotSchema();
        if (afterUp === before) {
          // A migration that changes nothing records a version with no effect.
          // Historically redundant migrations (e.g. 007_add_user_email, which
          // duplicates 003) are reported, not failed — the critical invariant
          // below (rollback restores the exact previous state) still holds.
          noOps.push(migration.name);
        }

        await rollbackOne(migration.downPath, migration.version);

        const afterDown = await snapshotSchema();
        if (afterDown !== before) {
          // eslint-disable-next-line no-console
          console.log(`ROLLBACK MISMATCH at ${migration.name}`);
        }
        expect(afterDown).toEqual(before);

        // Re-apply so the chain continues from the post-migration state.
        await applyOne(migration.upPath, migration.version);
      }

      const covered = migrations.length - skipped.length;
      // eslint-disable-next-line no-console
      console.log(
        `Rollback verified for ${covered}/${migrations.length} migrations.` +
          (skipped.length > 0
            ? ` NOT covered (missing .down.sql): ${skipped.join(", ")}`
            : "") +
          (noOps.length > 0
            ? `\nNo-op migrations (apply without schema change): ${noOps.join(", ")}`
            : ""),
      );
      expect(skipped).toEqual([]);
    },
    900000,
  );
});
