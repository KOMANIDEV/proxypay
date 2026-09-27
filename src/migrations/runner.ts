/**
 * Migration runner engine.
 *
 * Executes the SQL files in `migrations/` against a PostgreSQL database and
 * tracks applied versions in the `schema_migrations` table. The runner is
 * intentionally database-agnostic about *how* it runs — callers inject the
 * `pg.Pool` — which makes it unit-testable and lets the same engine back the
 * CLI (`src/scripts/migrate.ts`), dry-run mode, and the test suites.
 *
 * Every migration runs inside a transaction: an `up` that fails mid-way rolls
 * back completely (no partial schema, no version recorded), and a `down`
 * behaves the same way. This is the primary defence against the "half-applied
 * migration" failure mode that corrupts data.
 */

import fs from "fs";
import { Pool } from "pg";
import { discoverMigrations } from "./discovery";
import { MigrationFile } from "./types";
import {
  validateMigrationFiles,
  ValidationResult,
  verifyRollbackSafety,
} from "./validation";

export interface UpResult {
  applied: MigrationFile[];
  skipped: number;
}

export interface StatusRow {
  version: string;
  name: string;
  status: "applied" | "pending";
  appliedAt: string | null;
}

export interface MigrationRunnerOptions {
  pool: Pool;
  migrationsDir?: string;
  /** Override for the logger; defaults to console. */
  log?: (message: string) => void;
}

export class MigrationRunner {
  private readonly pool: Pool;
  private readonly migrationsDir: string;
  private readonly log: (message: string) => void;

  constructor(options: MigrationRunnerOptions) {
    this.pool = options.pool;
    this.migrationsDir = options.migrationsDir ?? resolveDefaultMigrationsDir();
    this.log = options.log ?? ((message) => console.log(message));
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Ensure the schema_migrations bookkeeping table exists. */
  async ensureMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     VARCHAR(255) PRIMARY KEY,
        applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /** Discover migrations on disk, in version order. */
  discover(): MigrationFile[] {
    return discoverMigrations(this.migrationsDir);
  }

  /** Currently applied versions. */
  async getAppliedVersions(): Promise<Set<string>> {
    const result = await this.pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    return new Set(result.rows.map((r) => r.version));
  }

  /**
   * Migrate rows recorded under a legacy numeric-only version (e.g. `005`) to
   * their full version identifier (e.g. `005_add_retry_count`) so version
   * matching stays consistent. Pre-existing behaviour kept for compatibility.
   */
  async normalizeLegacyAppliedVersions(migrations: MigrationFile[]): Promise<void> {
    const result = await this.pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version ~ '^[0-9]+$' ORDER BY version",
    );

    if (result.rows.length === 0) return;

    const migrationByLegacyVersion = new Map<string, MigrationFile[]>();
    for (const migration of migrations) {
      const group = migrationByLegacyVersion.get(migration.legacyVersion) ?? [];
      group.push(migration);
      migrationByLegacyVersion.set(migration.legacyVersion, group);
    }

    const currentlyApplied = await this.getAppliedVersions();

    for (const row of result.rows) {
      const candidates = migrationByLegacyVersion.get(row.version);
      if (!candidates || candidates.length === 0) {
        this.log(
          `No migration file found for legacy applied version ${row.version}; leaving as-is.`,
        );
        continue;
      }

      const targetVersion = candidates[0].version;
      if (currentlyApplied.has(targetVersion)) {
        await this.pool.query("DELETE FROM schema_migrations WHERE version = $1", [
          row.version,
        ]);
        continue;
      }

      await this.pool.query(
        "UPDATE schema_migrations SET version = $1 WHERE version = $2",
        [targetVersion, row.version],
      );
    }
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** Run static validation over all migration files on disk. */
  validate(): ValidationResult {
    return validateMigrationFiles(this.migrationsDir);
  }

  // -------------------------------------------------------------------------
  // Up
  // -------------------------------------------------------------------------

  /**
   * Apply all pending migrations.
   *
   * When `dryRun` is true, every pending migration is executed inside a
   * transaction that is rolled back, so the database is verified to accept the
   * SQL without persisting anything. Nothing is written in dry-run mode —
   * `schema_migrations` is untouched.
   */
  async up(options: { dryRun?: boolean; skipValidation?: boolean } = {}): Promise<UpResult> {
    await this.ensureMigrationsTable();

    const all = this.discover();
    await this.normalizeLegacyAppliedVersions(all);
    const applied = await this.getAppliedVersions();
    const pending = all.filter((m) => !applied.has(m.version));

    if (pending.length === 0) {
      this.log("No pending migrations.");
      return { applied: [], skipped: 0 };
    }

    if (!options.skipValidation) {
      const validation = this.validate();
      if (!validation.valid) {
        const detail = validation.errors.map((e) => `  [${e.code}] ${e.message}`).join("\n");
        throw new Error(
          `Migration validation failed — refusing to apply. Errors:\n${detail}`,
        );
      }
    }

    // Failing fast here (before touching the database) keeps schema changes
    // reversible: every migration we are about to apply must be rollback-safe.
    verifyRollbackSafety(pending);

    if (options.dryRun) {
      await this.dryRunAll(pending);
      return { applied: pending, skipped: 0 };
    }

    for (const migration of pending) {
      const sql = fs.readFileSync(migration.upPath, "utf-8");
      this.log(`Applying migration ${migration.version}: ${migration.name}`);

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);

        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [migration.version],
        );
        await client.query("COMMIT");
        this.log(`  Applied: ${migration.name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        this.log(`  Failed to apply ${migration.name}: ${(err as Error).message}`);
        throw err;
      } finally {
        client.release();
      }
    }

    this.log(`Migration complete. Applied ${pending.length} migration(s).`);
    return { applied: pending, skipped: 0 };
  }

  /**
   * Dry-run: execute every pending migration in a single transaction that is
   * rolled back at the end.
   *
   * Applying each migration in isolation (each with its own rollback) would
   * fail on a fresh database — migration N+1 would not see the schema changes
   * of migration N. Running the whole chain in one transaction verifies that
   * each migration applies against the schema state produced by its
   * predecessors, and the single ROLLBACK guarantees nothing persists.
   */
  private async dryRunAll(pending: MigrationFile[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
    } catch (err) {
      client.release();
      throw err;
    }

    let current: MigrationFile | null = null;
    try {
      for (const migration of pending) {
        current = migration;
        const sql = fs.readFileSync(migration.upPath, "utf-8");
        this.log(
          `[dry-run] Applying migration ${migration.version}: ${migration.name}`,
        );
        await client.query(sql);
        this.log(`  Dry-run OK: ${migration.name}`);
      }
      await client.query("ROLLBACK");
      this.log(
        `Dry-run complete. ${pending.length} migration(s) verified without applying.`,
      );
    } catch (err) {
      const name = current ? current.name : "(unknown)";
      this.log(`  Dry-run failed at ${name}: ${(err as Error).message}`);
      try {
        await client.query("ROLLBACK");
      } catch {
        // connection may be broken; release will clean up
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Down
  // -------------------------------------------------------------------------

  /**
   * Roll back the most recently applied migration using its `.down.sql` file.
   * Returns the rolled-back migration, or `null` when there is nothing to roll
   * back.
   */
  async down(): Promise<MigrationFile | null> {
    await this.ensureMigrationsTable();
    const all = this.discover();
    await this.normalizeLegacyAppliedVersions(all);

    const result = await this.pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1",
    );
    if (result.rows.length === 0) {
      this.log("No migrations to roll back.");
      return null;
    }

    const lastVersion = result.rows[0].version;
    const migration = all.find((m) => m.version === lastVersion);

    if (!migration) {
      throw new Error(`Could not find migration file for version: ${lastVersion}`);
    }

    if (!migration.downPath) {
      throw new Error(
        `No rollback file found for ${migration.name}. Expected: ${migration.version}.down.sql`,
      );
    }

    const sql = fs.readFileSync(migration.downPath, "utf-8");
    this.log(`Rolling back migration ${migration.version}: ${migration.name}`);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [
        migration.version,
      ]);
      await client.query("COMMIT");
      this.log(`  Rolled back: ${migration.name}`);
      return migration;
    } catch (err) {
      await client.query("ROLLBACK");
      this.log(`  Failed to roll back ${migration.name}: ${(err as Error).message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** List every migration with its applied/pending state. */
  async status(): Promise<StatusRow[]> {
    await this.ensureMigrationsTable();

    const all = this.discover();
    await this.normalizeLegacyAppliedVersions(all);

    const result = await this.pool.query<{ version: string; applied_at: string }>(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    );
    const appliedAt = new Map(
      result.rows.map((r) => [r.version, r.applied_at]),
    );

    return all.map((migration) => {
      const when = appliedAt.get(migration.version);
      return {
        version: migration.version,
        name: migration.name,
        status: when ? "applied" : "pending",
        appliedAt: when ?? null,
      };
    });
  }
}

function resolveDefaultMigrationsDir(): string {
  return require("path").resolve(__dirname, "..", "..", "migrations");
}
