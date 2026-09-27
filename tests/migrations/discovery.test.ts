import { describe, expect, it, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import {
  discoverMigrations,
  findIgnoredSqlFiles,
  MIGRATION_FILE_PATTERN,
} from "../../src/migrations/discovery";

const tmpDirs: string[] = [];

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-discovery-"));
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

describe("discoverMigrations", () => {
  it("discovers migrations in version order and pairs them with down files", () => {
    const dir = makeDir({
      "001_initial.sql": "SELECT 1;",
      "001_initial.down.sql": "SELECT 2;",
      "002_add_things.sql": "SELECT 3;",
      "002_add_things.down.sql": "SELECT 4;",
      "003_no_down.sql": "SELECT 5;",
      "readme.md": "not sql",
    });

    const migrations = discoverMigrations(dir);
    expect(migrations.map((m) => m.name)).toEqual([
      "001_initial.sql",
      "002_add_things.sql",
      "003_no_down.sql",
    ]);
    expect(migrations[0].version).toBe("001_initial");
    expect(migrations[0].legacyVersion).toBe("001");
    expect(migrations[0].downPath).toBe(path.join(dir, "001_initial.down.sql"));
    expect(migrations[1].downPath).toBe(path.join(dir, "002_add_things.down.sql"));
    expect(migrations[2].downPath).toBeNull();
    expect(migrations[2].upPath).toBe(path.join(dir, "003_no_down.sql"));
  });

  it("ignores .down.sql files and non-conforming files", () => {
    const dir = makeDir({
      "001_initial.sql": "SELECT 1;",
      "001_initial.down.sql": "SELECT 2;",
      "add_missing_index.sql": "SELECT 3;",
      "20260101_stuff.sql": "SELECT 4;",
    });

    const migrations = discoverMigrations(dir);
    expect(migrations.map((m) => m.name)).toEqual([
      "001_initial.sql",
      "20260101_stuff.sql",
    ]);
  });

  it("does not treat numeric-prefix duplicates as errors (legacy numbering)", () => {
    // The version identifier is the full filename (minus .sql), so migrations
    // that share a numeric prefix — like the real set's 009_* and 010_* files
    // — are distinct migrations, not duplicates.
    const dir = makeDir({
      "001_initial.sql": "SELECT 1;",
      "001_other.sql": "SELECT 2;",
      "009_a.sql": "SELECT 3;",
      "009_b.sql": "SELECT 4;",
    });
    const migrations = discoverMigrations(dir);
    expect(migrations.map((m) => m.version)).toEqual([
      "001_initial",
      "001_other",
      "009_a",
      "009_b",
    ]);
  });
});

describe("findIgnoredSqlFiles", () => {
  it("returns SQL files that the runner would silently skip", () => {
    const dir = makeDir({
      "001_initial.sql": "SELECT 1;",
      "add_missing_index.sql": "SELECT 2;",
      "whatever.sql": "SELECT 3;",
      "notes.txt": "x",
    });
    expect(findIgnoredSqlFiles(dir)).toEqual([
      "add_missing_index.sql",
      "whatever.sql",
    ]);
  });
});

describe("MIGRATION_FILE_PATTERN", () => {
  it("matches the documented naming convention", () => {
    expect(MIGRATION_FILE_PATTERN.test("001_initial_schema.sql")).toBe(true);
    expect(MIGRATION_FILE_PATTERN.test("20260825_create_things.sql")).toBe(true);
    expect(MIGRATION_FILE_PATTERN.test("001_initial_schema.down.sql")).toBe(true);
    expect(MIGRATION_FILE_PATTERN.test("add_missing_index.sql")).toBe(false);
    expect(MIGRATION_FILE_PATTERN.test("schema.sql")).toBe(false);
  });
});
