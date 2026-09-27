/**
 * Shared types for the migration library (`src/migrations/*`).
 *
 * These types describe the migration files on disk, the results of static
 * validation, and the impact analysis produced from parsing the SQL.
 */

export interface MigrationFile {
  /** Full version identifier, e.g. `20260424_create_daily_snapshots`. */
  version: string;
  /** Legacy numeric-only prefix, e.g. `20260424` (or `001` for legacy files). */
  legacyVersion: string;
  /** Filename, e.g. `20260424_create_daily_snapshots.sql`. */
  name: string;
  /** Absolute path to the up migration SQL file. */
  upPath: string;
  /** Absolute path to the matching `.down.sql` file, or `null` when missing. */
  downPath: string | null;
}

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  /** Migration filename this issue refers to, when applicable. */
  file?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export type ImpactObjectType =
  | "table"
  | "column"
  | "index"
  | "constraint"
  | "type"
  | "view"
  | "function"
  | "trigger"
  | "sequence"
  | "extension";

export interface ImpactEntry {
  type: ImpactObjectType;
  name: string;
}

export interface DataOperation {
  op: "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";
  table: string;
}

export interface MigrationImpact {
  version: string;
  name: string;
  creates: ImpactEntry[];
  alters: ImpactEntry[];
  drops: ImpactEntry[];
  dataOps: DataOperation[];
  /** Raw parsed statements (comments stripped), for reporting. */
  statements: string[];
}

export interface ConflictFinding {
  severity: "error" | "warning" | "info";
  kind: string;
  message: string;
  /** Migration filename(s) involved. */
  migrations: string[];
}

export interface ImpactReport {
  impacts: MigrationImpact[];
  conflicts: ConflictFinding[];
  /** Migration filenames that reference objects they never created. */
  orphanDrops: ConflictFinding[];
}
