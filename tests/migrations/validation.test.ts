import { describe, expect, it, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import {
  validateMigrationFiles,
  verifyRollbackSafety,
} from "../../src/migrations/validation";
import { discoverMigrations } from "../../src/migrations/discovery";

const tmpDirs: string[] = [];

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-validate-"));
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

describe("validateMigrationFiles", () => {
  it("returns valid for a well-formed migration with a rollback file", () => {
    const dir = makeDir({
      "001_create_users.sql": "CREATE TABLE users (id INT PRIMARY KEY);",
      "001_create_users.down.sql": "DROP TABLE users;",
    });
    const result = validateMigrationFiles(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags a missing rollback file as a warning, not an error", () => {
    const dir = makeDir({
      "001_create_users.sql": "CREATE TABLE users (id INT PRIMARY KEY);",
    });
    const result = validateMigrationFiles(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "MISSING_ROLLBACK_FILE")).toBe(
      true,
    );
  });

  it("flags an empty up migration as an error", () => {
    const dir = makeDir({
      "001_empty.sql": "  -- nothing here\n",
      "001_empty.down.sql": "SELECT 1;",
    });
    const result = validateMigrationFiles(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "EMPTY_MIGRATION")).toBe(true);
  });

  it("flags unterminated SQL as an error", () => {
    const dir = makeDir({
      "001_broken.sql": "CREATE TABLE users (id INT); /* never closed",
      "001_broken.down.sql": "SELECT 1;",
    });
    const result = validateMigrationFiles(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "UNTERMINATED_SQL")).toBe(true);
  });

  it("flags a non-conforming SQL file that the runner would ignore", () => {
    const dir = makeDir({
      "001_ok.sql": "SELECT 1;",
      "add_missing_index.sql": "CREATE INDEX i ON users(id);",
    });
    const result = validateMigrationFiles(dir);
    expect(result.warnings.some((w) => w.code === "NON_CONFORMING_FILENAME")).toBe(
      true,
    );
  });

  it("escalates destructive statements without a rollback file to errors", () => {
    const dir = makeDir({
      "001_drop_stuff.sql": "DROP TABLE legacy_users;",
    });
    const result = validateMigrationFiles(dir);
    expect(result.errors.some((e) => e.code === "DESTRUCTIVE_STATEMENT")).toBe(
      true,
    );
  });

  it("downgrades destructive statements to warnings when a rollback file exists", () => {
    const dir = makeDir({
      "001_drop_stuff.sql": "DROP TABLE legacy_users;",
      "001_drop_stuff.down.sql": "CREATE TABLE legacy_users (id INT);",
    });
    const result = validateMigrationFiles(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "DESTRUCTIVE_STATEMENT")).toBe(
      true,
    );
  });

  it("flags an empty rollback file as an error", () => {
    const dir = makeDir({
      "001_ok.sql": "CREATE TABLE users (id INT);",
      "001_ok.down.sql": "-- nothing to undo\n",
    });
    const result = validateMigrationFiles(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "EMPTY_ROLLBACK")).toBe(true);
  });

  it("treats same-numeric-prefix migrations as distinct (no duplicate-version error)", () => {
    // Version identifiers are the full filenames, so 001_a and 001_b (like the
    // real set's 009_* files) are distinct migrations, not duplicates.
    const dir = makeDir({
      "001_a.sql": "SELECT 1;",
      "001_b.sql": "SELECT 2;",
      "001_a.down.sql": "SELECT 3;",
      "001_b.down.sql": "SELECT 4;",
    });
    const result = validateMigrationFiles(dir);
    expect(result.valid).toBe(true);
    expect(result.errors.some((e) => e.code === "DUPLICATE_VERSION")).toBe(false);
  });

  it("ignores comment prose that mentions destructive SQL", () => {
    const dir = makeDir({
      "001_safe.sql": "-- DROP TABLE users; is a comment, not code\nSELECT 1;",
      "001_safe.down.sql": "SELECT 2;",
    });
    const result = validateMigrationFiles(dir);
    expect(
      result.issues.some(
        (i) => i.code === "DESTRUCTIVE_STATEMENT" && i.severity === "warning",
      ),
    ).toBe(false);
  });
});

describe("verifyRollbackSafety", () => {
  it("throws when any pending migration is missing a rollback file", () => {
    const dir = makeDir({
      "001_ok.sql": "SELECT 1;",
      "002_no_down.sql": "SELECT 2;",
    });
    const migrations = discoverMigrations(dir);
    expect(() => verifyRollbackSafety(migrations)).toThrow(/missing rollback file/);
  });

  it("passes when every pending migration has a rollback file", () => {
    const dir = makeDir({
      "001_ok.sql": "SELECT 1;",
      "001_ok.down.sql": "SELECT 2;",
      "002_ok.sql": "SELECT 3;",
      "002_ok.down.sql": "SELECT 4;",
    });
    const migrations = discoverMigrations(dir);
    expect(() => verifyRollbackSafety(migrations)).not.toThrow();
  });
});
