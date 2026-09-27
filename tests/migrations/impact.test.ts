import { describe, expect, it, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import {
  analyzeMigrationSql,
  analyzeMigrationsDir,
} from "../../src/migrations/impact";

const tmpDirs: string[] = [];

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-impact-"));
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

function names(entries: { type: string; name: string }[]): string[] {
  return entries.map((e) => e.name);
}

describe("analyzeMigrationSql", () => {
  it("detects created tables, indexes, functions and triggers", () => {
    const impact = analyzeMigrationSql(
      `
      CREATE TABLE IF NOT EXISTS payment_links (id UUID PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS idx_payment_links_token ON payment_links(token);
      CREATE OR REPLACE FUNCTION touch() RETURNS TRIGGER AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS old_trigger ON payment_links;
      CREATE TRIGGER payment_links_updated_at BEFORE UPDATE ON payment_links
        FOR EACH ROW EXECUTE FUNCTION touch();
      `,
      "001_create_payment_links.sql",
    );
    expect(impact.creates.map((c) => `${c.type}:${c.name}`)).toEqual([
      "table:payment_links",
      "index:idx_payment_links_token",
      "function:touch",
      "trigger:payment_links_updated_at",
    ]);
    expect(impact.drops.map((d) => `${d.type}:${d.name}`)).toEqual([
      "trigger:old_trigger",
    ]);
  });

  it("detects column additions and drops in ALTER TABLE", () => {
    const impact = analyzeMigrationSql(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT, ADD COLUMN last_name TEXT;",
      "001_add_pii.sql",
    );
    expect(impact.creates.filter((c) => c.type === "column").map((c) => c.name)).toEqual(
      ["users.first_name", "users.last_name"],
    );
  });

  it("detects named constraint additions and drops without confusing ADD COLUMN", () => {
    const impact = analyzeMigrationSql(
      [
        "ALTER TABLE transactions ADD COLUMN status VARCHAR(20);",
        "ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN ('a','b'));",
        "ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_old_check;",
      ].join("\n"),
      "001_constraints.sql",
    );
    const constraints = impact.creates.filter((c) => c.type === "constraint");
    expect(constraints.map((c) => c.name)).toEqual([
      "transactions.transactions_status_check",
    ]);
    expect(impact.drops.map((d) => d.name)).toEqual([
      "transactions.transactions_old_check",
    ]);
    expect(impact.creates.some((c) => c.name === "transactions.COLUMN")).toBe(false);
  });

  it("detects table renames", () => {
    const impact = analyzeMigrationSql(
      "ALTER TABLE transactions RENAME TO transactions_legacy;",
      "001_rename.sql",
    );
    expect(impact.alters.map((a) => a.name)).toContain(
      "transactions → transactions_legacy",
    );
  });

  it("detects data-modifying statements", () => {
    const impact = analyzeMigrationSql(
      "UPDATE users SET status = 'active'; DELETE FROM sessions WHERE expires_at < NOW();",
      "001_data.sql",
    );
    expect(impact.dataOps).toEqual([
      { op: "UPDATE", table: "users" },
      { op: "DELETE", table: "sessions" },
    ]);
  });

  it("reports no effects for benign statements", () => {
    const impact = analyzeMigrationSql("COMMENT ON TABLE users IS 'x';", "001.sql");
    expect(impact.creates).toEqual([]);
    expect(impact.alters).toEqual([]);
    expect(impact.drops).toEqual([]);
  });

  it("does not match keywords inside comment prose", () => {
    const impact = analyzeMigrationSql(
      "-- DROP TABLE users; UPDATE users; TRUNCATE users;\nSELECT 1;",
      "001.sql",
    );
    expect(impact.creates).toEqual([]);
    expect(impact.drops).toEqual([]);
    expect(impact.dataOps).toEqual([]);
  });
});

describe("analyzeMigrationsDir", () => {
  it("flags duplicate object creation across migrations", () => {
    const dir = makeDir({
      "001_create.sql": "CREATE TABLE users (id INT);",
      "002_create_again.sql": "CREATE TABLE IF NOT EXISTS users (id INT);",
    });
    const report = analyzeMigrationsDir(dir);
    expect(
      report.conflicts.some((c) => c.kind === "DUPLICATE_OBJECT_CREATE"),
    ).toBe(true);
  });

  it("flags orphan drops (objects no migration creates)", () => {
    const dir = makeDir({
      "001_drop.sql": "DROP TABLE IF EXISTS legacy_things;",
    });
    const report = analyzeMigrationsDir(dir);
    expect(report.conflicts.some((c) => c.kind === "ORPHAN_DROP")).toBe(true);
  });

  it("treats drops of objects created by earlier migrations as informational", () => {
    const dir = makeDir({
      "001_create.sql": "CREATE TABLE foo (id INT);",
      "002_drop.sql": "DROP TABLE foo;",
    });
    const report = analyzeMigrationsDir(dir);
    expect(report.conflicts.some((c) => c.kind === "ORPHAN_DROP")).toBe(false);
    expect(report.conflicts.some((c) => c.kind === "REFERENTIAL_DROP")).toBe(true);
  });

  it("flags data-modifying migrations", () => {
    const dir = makeDir({
      "001_data.sql": "UPDATE users SET status = 'active';",
    });
    const report = analyzeMigrationsDir(dir);
    expect(report.conflicts.some((c) => c.kind === "DATA_MODIFYING")).toBe(true);
  });

  it("handles partition attachments", () => {
    const impact = analyzeMigrationSql(
      "ALTER TABLE transactions ATTACH PARTITION transactions_legacy DEFAULT;",
      "001.sql",
    );
    expect(impact.alters.map((a) => a.name)).toContain(
      "transactions (attach partition transactions_legacy)",
    );
  });
});
