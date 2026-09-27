/**
 * Migration validation — static checks performed before any migration SQL is
 * executed against a database.
 *
 * These checks are intentionally cheap and side-effect free: they operate on
 * the migration files on disk, so they can run in CI or as a pre-flight step
 * before `migrate:up` touches the database. Syntax-level validation (does the
 * SQL actually run?) is covered separately by dry-run mode, which executes
 * every migration inside a rolled-back transaction.
 */

import fs from "fs";
import path from "path";
import {
  discoverMigrations,
  findIgnoredSqlFiles,
  MIGRATION_FILE_PATTERN,
} from "./discovery";
import { splitSqlStatements } from "./sql";
import {
  MigrationFile,
  ValidationIssue,
  ValidationResult,
} from "./types";

/**
 * Validate the migration directory as a whole.
 *
 * `error` issues block a migration run; `warning` issues report risk (mostly
 * legacy rollback debt) without blocking; `info` items are informational.
 */
export function validateMigrationFiles(migrationsDir: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  let migrations: MigrationFile[] = [];

  try {
    migrations = discoverMigrations(migrationsDir);
  } catch (err) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_VERSION",
      message: err instanceof Error ? err.message : String(err),
    });
    return { valid: false, issues, errors: issues, warnings: [] };
  }

  // Files that do not follow the naming convention are silently ignored by the
  // runner — a footgun, since they look like they should be applied.
  const ignored = findIgnoredSqlFiles(migrationsDir);
  for (const file of ignored) {
    issues.push({
      severity: "warning",
      code: "NON_CONFORMING_FILENAME",
      message: `SQL file "${file}" does not match the migration naming convention (<NNN>_<description>.sql) and will be silently ignored by migrate:up. Rename it or move it out of the migrations directory.`,
      file,
    });
  }

  for (const migration of migrations) {
    issues.push(...validateUpFile(migration));
    if (migration.downPath) {
      issues.push(...validateDownFile(migration));
    } else {
      issues.push({
        severity: "warning",
        code: "MISSING_ROLLBACK_FILE",
        message: `No rollback file (${migration.version}.down.sql) exists. This migration cannot be rolled back; rollback testing will skip it.`,
        file: migration.name,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { valid: errors.length === 0, issues, errors, warnings };
}

function validateUpFile(migration: MigrationFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sql: string;
  try {
    sql = fs.readFileSync(migration.upPath, "utf-8");
  } catch {
    issues.push({
      severity: "error",
      code: "UNREADABLE_FILE",
      message: `Could not read migration file: ${migration.upPath}`,
      file: migration.name,
    });
    return issues;
  }

  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    issues.push({
      severity: "error",
      code: "EMPTY_MIGRATION",
      message: `Migration file is empty — applying it would record a version with no schema change.`,
      file: migration.name,
    });
    return issues;
  }

  const parsed = splitSqlStatements(sql);
  if (parsed.unterminated) {
    issues.push({
      severity: "error",
      code: "UNTERMINATED_SQL",
      message: `SQL contains an unterminated quote or comment (near offset ${parsed.unterminatedAt}). The migration cannot be parsed; it will fail at runtime.`,
      file: migration.name,
    });
    return issues;
  }

  if (parsed.statements.length === 0) {
    issues.push({
      severity: "error",
      code: "EMPTY_MIGRATION",
      message: `Migration contains only comments — applying it would record a version with no schema change.`,
      file: migration.name,
    });
    return issues;
  }

  // Destructive statements in an up migration are a rollback risk.
  const destructive = findDestructiveStatements(parsed.statements);
  for (const { statement, kind } of destructive) {
    const hasDown = migration.downPath !== null;
    issues.push({
      severity: hasDown ? "warning" : "error",
      code: "DESTRUCTIVE_STATEMENT",
      message: `Up migration contains ${kind} statement, which is irreversible${hasDown ? "" : " and there is no rollback file"}: "${truncate(statement, 120)}"`,
      file: migration.name,
    });
  }

  return issues;
}

function validateDownFile(migration: MigrationFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let sql: string;
  try {
    sql = fs.readFileSync(migration.downPath, "utf-8");
  } catch {
    issues.push({
      severity: "error",
      code: "UNREADABLE_FILE",
      message: `Could not read rollback file: ${migration.downPath}`,
      file: migration.name,
    });
    return issues;
  }

  const parsed = splitSqlStatements(sql);
  if (parsed.unterminated) {
    issues.push({
      severity: "error",
      code: "UNTERMINATED_SQL",
      message: `Rollback file contains an unterminated quote or comment (near offset ${parsed.unterminatedAt}).`,
      file: migration.name,
    });
    return issues;
  }

  if (parsed.statements.length === 0) {
    issues.push({
      severity: "error",
      code: "EMPTY_ROLLBACK",
      message: `Rollback file contains no statements — rolling back would record nothing and leave the schema unchanged.`,
      file: migration.name,
    });
    return issues;
  }

  return issues;
}

const DESTRUCTIVE_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { kind: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
  { kind: "DROP INDEX", pattern: /\bDROP\s+INDEX\b/i },
  { kind: "DROP CONSTRAINT", pattern: /\bDROP\s+CONSTRAINT\b/i },
  { kind: "DROP TYPE", pattern: /\bDROP\s+TYPE\b/i },
  { kind: "DROP VIEW", pattern: /\bDROP\s+VIEW\b/i },
  { kind: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { kind: "DELETE", pattern: /\bDELETE\s+FROM\b/i },
  { kind: "UPDATE", pattern: /\bUPDATE\b/i },
  { kind: "DROP FUNCTION", pattern: /\bDROP\s+FUNCTION\b/i },
  { kind: "DROP TRIGGER", pattern: /\bDROP\s+TRIGGER\b/i },
];

function findDestructiveStatements(
  statements: string[],
): Array<{ statement: string; kind: string }> {
  const found: Array<{ statement: string; kind: string }> = [];
  for (const statement of statements) {
    for (const { kind, pattern } of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(statement)) {
        found.push({ statement, kind });
        break;
      }
    }
  }
  return found;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Pre-flight check used by the runner before applying pending migrations:
 * every pending migration must have a matching `.down.sql` file so the schema
 * changes remain reversible. Throws when any pending migration is missing one.
 */
export function verifyRollbackSafety(pending: MigrationFile[]): void {
  const missingRollback = pending.filter((m) => !m.downPath);
  if (missingRollback.length > 0) {
    const names = missingRollback.map((m) => m.name).join(", ");
    throw new Error(
      `Pre-flight check failed: missing rollback file (.down.sql) for: ${names}. ` +
        `Add a rollback file for each migration before applying.`,
    );
  }
}

/** Format a validation result for human consumption (CLI output). */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = ["Migration Validation Report", "========================="];
  const grouped: Record<string, ValidationIssue[]> = {
    error: result.errors,
    warning: result.warnings,
    info: result.issues.filter((i) => i.severity === "info"),
  };
  for (const severity of ["error", "warning", "info"] as const) {
    const items = grouped[severity];
    if (items.length === 0) continue;
    lines.push(`\n${items.length} ${severity}${items.length === 1 ? "" : "s"}:`);
    for (const issue of items) {
      lines.push(`  [${issue.code}] ${issue.file ? `(${issue.file}) ` : ""}${issue.message}`);
    }
  }
  lines.push(
    `\nResult: ${result.valid ? "VALID" : "INVALID"} ` +
      `(${result.errors.length} error(s), ${result.warnings.length} warning(s))`,
  );
  return lines.join("\n");
}

export { MIGRATION_FILE_PATTERN };

/** Resolve the project migrations directory from a module location. */
export function resolveMigrationsDir(fromDir: string = __dirname): string {
  return path.resolve(fromDir, "..", "..", "migrations");
}
