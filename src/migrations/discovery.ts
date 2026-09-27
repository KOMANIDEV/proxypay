/**
 * Migration file discovery.
 *
 * Scans a migrations directory for files following the naming convention
 * `<NNN>_<description>.sql` and pairs each one with its optional
 * `<NNN>_<description>.down.sql` rollback file.
 */

import fs from "fs";
import path from "path";
import { MigrationFile } from "./types";

/** Matches up-migration filenames: a numeric prefix followed by a description. */
export const MIGRATION_FILE_PATTERN = /^(\d+)_(.+)\.sql$/;

/**
 * Discover all up-migrations in a directory, in lexical (version) order.
 *
 * Throws when two files resolve to the same version identifier, since that
 * would make the applied-versions bookkeeping ambiguous.
 */
export function discoverMigrations(migrationsDir: string): MigrationFile[] {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => MIGRATION_FILE_PATTERN.test(f) && !f.endsWith(".down.sql"))
    .sort();

  const migrations = files.map((filename) => {
    const match = filename.match(MIGRATION_FILE_PATTERN);
    if (!match) {
      throw new Error(`Unexpected migration filename: ${filename}`);
    }

    const [, legacyVersion, label] = match;
    const downFilename = `${legacyVersion}_${label}.down.sql`;
    const downPath = path.join(migrationsDir, downFilename);

    return {
      version: filename.replace(/\.sql$/, ""),
      legacyVersion,
      name: filename,
      upPath: path.join(migrationsDir, filename),
      downPath: fs.existsSync(downPath) ? downPath : null,
    };
  });

  const versions = new Map<string, string[]>();
  for (const migration of migrations) {
    const existing = versions.get(migration.version) ?? [];
    existing.push(migration.name);
    versions.set(migration.version, existing);
  }

  const duplicates = [...versions.entries()].filter(
    ([, names]) => names.length > 1,
  );

  if (duplicates.length > 0) {
    const lines = duplicates
      .map(([version, names]) => `version ${version}: ${names.join(", ")}`)
      .join("; ");
    throw new Error(
      `Duplicate migration version prefix detected. Each migration number must be unique. Conflicts: ${lines}`,
    );
  }

  return migrations;
}

/**
 * List non-conforming SQL files present in the migrations directory that are
 * silently ignored by the runner. These are a footgun: they never run but look
 * like they should.
 */
export function findIgnoredSqlFiles(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && !MIGRATION_FILE_PATTERN.test(f))
    .sort();
}
