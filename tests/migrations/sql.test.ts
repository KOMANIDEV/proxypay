import { describe, expect, it } from "@jest/globals";
import { splitSqlStatements } from "../../src/migrations/sql";

describe("splitSqlStatements", () => {
  it("splits simple statements on semicolons", () => {
    const result = splitSqlStatements("SELECT 1;\nSELECT 2;");
    expect(result.statements).toEqual(["SELECT 1", "SELECT 2"]);
    expect(result.unterminated).toBe(false);
  });

  it("handles a trailing statement without a semicolon", () => {
    const result = splitSqlStatements("SELECT 1;\nSELECT 2");
    expect(result.statements).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores line comments and keeps statement text clean", () => {
    const result = splitSqlStatements(
      "-- header comment\nCREATE TABLE users (id INT);\n-- ALTER TABLE users DROP COLUMN x;",
    );
    expect(result.statements).toEqual(["CREATE TABLE users (id INT)"]);
  });

  it("does not let comments inside a statement split it", () => {
    const sql = [
      "ALTER TABLE users",
      "  ADD COLUMN foo TEXT, -- inline comment",
      "  ADD COLUMN bar TEXT;",
    ].join("\n");
    const result = splitSqlStatements(sql);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]).toContain("ADD COLUMN foo TEXT");
    expect(result.statements[0]).toContain("ADD COLUMN bar TEXT");
    expect(result.statements[0]).not.toContain("inline comment");
  });

  it("strips block comments", () => {
    const result = splitSqlStatements("/* multi\nline */ SELECT 1; /* tail */");
    expect(result.statements).toEqual(["SELECT 1"]);
  });

  it("keeps dollar-quoted function bodies as a single statement", () => {
    const sql = [
      "CREATE FUNCTION bump() RETURNS TRIGGER AS $$",
      "BEGIN",
      "  NEW.updated_at = CURRENT_TIMESTAMP;",
      "  RETURN NEW;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ].join("\n");
    const result = splitSqlStatements(sql);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]).toContain("CREATE FUNCTION bump()");
    expect(result.statements[0]).toContain("NEW.updated_at = CURRENT_TIMESTAMP;");
  });

  it("keeps DO blocks as a single statement", () => {
    const sql = "DO $$ BEGIN PERFORM 1; END $$;";
    const result = splitSqlStatements(sql);
    expect(result.statements).toEqual(["DO $$ BEGIN PERFORM 1; END $$"]);
  });

  it("keeps semicolons inside single-quoted strings", () => {
    const result = splitSqlStatements("INSERT INTO t (v) VALUES ('a;b');");
    expect(result.statements).toEqual(["INSERT INTO t (v) VALUES ('a;b')"]);
  });

  it("handles doubled single quotes inside strings", () => {
    const result = splitSqlStatements("SELECT 'it''s; fine';");
    expect(result.statements).toEqual(["SELECT 'it''s; fine'"]);
  });

  it("handles double-quoted identifiers", () => {
    const result = splitSqlStatements('SELECT "weird;name" FROM t;');
    expect(result.statements).toEqual(['SELECT "weird;name" FROM t']);
  });

  it("flags unterminated block comments", () => {
    const result = splitSqlStatements("SELECT 1; /* never closed");
    expect(result.unterminated).toBe(true);
    expect(result.statements).toEqual(["SELECT 1"]);
  });

  it("flags unterminated single quotes", () => {
    const result = splitSqlStatements("SELECT 'oops;");
    expect(result.unterminated).toBe(true);
  });

  it("flags unterminated dollar quotes", () => {
    const result = splitSqlStatements("CREATE FUNCTION f() AS $$ BEGIN END");
    expect(result.unterminated).toBe(true);
  });

  it("handles empty and comment-only scripts", () => {
    expect(splitSqlStatements("").statements).toEqual([]);
    expect(splitSqlStatements("-- just a comment\n").statements).toEqual([]);
  });
});
