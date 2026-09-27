#!/usr/bin/env node
/**
 * Migration CLI (Issue #45 — hardened with validation, dry-run, and impact
 * analysis).
 *
 * A lightweight, dependency-free migration system using raw SQL files stored
 * in the `migrations/` directory. It tracks applied migrations in a
 * `schema_migrations` table in PostgreSQL.
 *
 * Usage (via npm scripts defined in package.json):
 *   npm run migrate:up        – apply all pending migrations
 *   npm run migrate:dry-run   – verify pending migrations without applying
 *   npm run migrate:down      – roll back the last applied migration
 *   npm run migrate:status    – list applied and pending migrations
 *   npm run migrate:validate  – static validation of every migration file
 *   npm run migrate:analyze   – impact analysis (objects created/altered/dropped)
 *   npm run migrate:create    – scaffold a new migration + rollback file
 *
 * SQL files must follow the naming convention:
 *   <NNN>_<description>.sql   (e.g. 001_initial_schema.sql)
 *
 * Rollback files must be stored alongside each migration as:
 *   <NNN>_<description>.down.sql
 */

import fs from "fs";
import path from "path";
import { Pool } from "pg";
import dotenv from "dotenv";
import { MigrationRunner } from "../migrations/runner";
import { analyzeMigrationsDir, formatImpactReport } from "../migrations/impact";
import { formatValidationResult } from "../migrations/validation";

dotenv.config();

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

const isSandbox = process.env.IS_SANDBOX === "true";
const dbUrl = isSandbox
  ? process.env.SANDBOX_DATABASE_URL || process.env.DATABASE_URL
  : process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: dbUrl,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const migrationsDir = path.resolve(__dirname, "..", "..", "migrations");
const runner = new MigrationRunner({ pool, migrationsDir });

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function printStatus(): Promise<void> {
  const rows = await runner.status();
  const appliedCount = rows.filter((r) => r.status === "applied").length;
  const pendingCount = rows.length - appliedCount;

  console.log("\nMigration Status:");
  console.log("=================");
  for (const row of rows) {
    console.log(`  [${row.status}] ${row.name}`);
  }
  console.log(
    `\nTotal: ${rows.length} migration(s), ${appliedCount} applied, ${pendingCount} pending.\n`,
  );
}

async function printValidate(): Promise<void> {
  const result = runner.validate();
  console.log(formatValidationResult(result));
  if (!result.valid) {
    process.exitCode = 1;
  }
}

async function printAnalyze(jsonOutput: boolean): Promise<void> {
  const report = analyzeMigrationsDir(migrationsDir);
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatImpactReport(report));
  }
}

async function createMigration(name: string | undefined): Promise<void> {
  if (!name || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error(
      `Invalid migration name: "${name ?? ""}". Use lowercase letters, digits and underscores, e.g. "add_user_avatar".`,
    );
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const version = `${stamp}_${name}`;
  const upPath = path.join(migrationsDir, `${version}.sql`);
  const downPath = path.join(migrationsDir, `${version}.down.sql`);

  if (fs.existsSync(upPath)) {
    throw new Error(`Migration already exists: ${version}`);
  }

  fs.writeFileSync(
    upPath,
    `-- Migration: ${version}\n-- Description: <describe the change>\n\n`,
  );
  fs.writeFileSync(
    downPath,
    `-- Rollback: ${version}\n-- Description: <reverse the change>\n\n`,
  );

  console.log(`Created migration files:\n  ${upPath}\n  ${downPath}`);
  console.log(
    "\nNote: the pre-flight rollback-safety check requires every new migration to ship with a .down.sql file — the template above is created for you.",
  );
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const command = process.argv[2];
const dryRun = process.argv.slice(3).includes("--dry-run");
const jsonOutput = process.argv.slice(3).includes("--json");
const createName = process.argv[3];

(async () => {
  try {
    switch (command) {
      case "up":
        await runner.up({ dryRun });
        break;
      case "down":
        await runner.down();
        break;
      case "status":
        await printStatus();
        break;
      case "validate":
        await printValidate();
        break;
      case "analyze":
        await printAnalyze(jsonOutput);
        break;
      case "create":
        await createMigration(createName);
        break;
      default:
        console.error(
          `Unknown command: ${command ?? "(none)"}.\nUsage: migrate <up|down|status|validate|analyze|create>`,
        );
        process.exitCode = 1;
    }
  } catch (err) {
    console.error("Migration runner error:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
