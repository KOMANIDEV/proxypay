/**
 * Migration impact analysis.
 *
 * Statically parses each migration's SQL and reports which database objects it
 * creates, alters, or drops, plus any data-modifying statements. It then
 * compares migrations against each other to surface cross-migration hazards
 * (e.g. two migrations creating the same table, or a drop of an object no
 * earlier migration created).
 *
 * The analysis is heuristic by nature — it reads the SQL text, it does not
 * execute it. Dry-run mode remains the source of truth for "does this SQL
 * actually run".
 */

import fs from "fs";
import { discoverMigrations } from "./discovery";
import { splitSqlStatements } from "./sql";
import {
  ConflictFinding,
  DataOperation,
  ImpactEntry,
  ImpactObjectType,
  ImpactReport,
  MigrationImpact,
} from "./types";

const IDENT = "[a-zA-Z_][a-zA-Z0-9_$]*";
const QUALIFIED = `(?:${IDENT}\\.)?(${IDENT})`;

const STATEMENT_PATTERNS: Array<{
  type: ImpactObjectType | "data";
  create?: boolean;
  pattern: RegExp;
  nameIndex?: number;
}> = [
  // Tables
  {
    type: "table",
    create: true,
    pattern: new RegExp(`\\bCREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  {
    type: "table",
    create: false,
    pattern: new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  // Indexes
  {
    type: "index",
    create: true,
    pattern: new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  {
    type: "index",
    create: false,
    pattern: new RegExp(`\\bDROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  // Types (enums, composite, range, domain)
  {
    type: "type",
    create: true,
    pattern: new RegExp(`\\bCREATE\\s+(?:TYPE|DOMAIN)\\s+${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  {
    type: "type",
    create: false,
    pattern: new RegExp(`\\bDROP\\s+TYPE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  // Views
  {
    type: "view",
    create: true,
    pattern: new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:MATERIALIZED\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  {
    type: "view",
    create: false,
    pattern: new RegExp(`\\bDROP\\s+(?:MATERIALIZED\\s+)?VIEW\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  // Functions
  {
    type: "function",
    create: true,
    pattern: new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  {
    type: "function",
    create: false,
    pattern: new RegExp(`\\bDROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  // Triggers
  {
    type: "trigger",
    create: true,
    pattern: new RegExp(`\\bCREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  {
    type: "trigger",
    create: false,
    pattern: new RegExp(`\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  // Sequences
  {
    type: "sequence",
    create: true,
    pattern: new RegExp(`\\bCREATE\\s+SEQUENCE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  {
    type: "sequence",
    create: false,
    pattern: new RegExp(`\\bDROP\\s+SEQUENCE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
  // Extensions
  {
    type: "extension",
    create: true,
    pattern: new RegExp(`\\bCREATE\\s+EXTENSION\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`, "i"),
    nameIndex: 1,
  },
];

const ALTER_TABLE_PATTERN = new RegExp(
  `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`,
  "i",
);

// The `g` flag is required for matchAll() to iterate over every clause; these
// patterns are only ever used with matchAll() inside analyzeAlterTable().
const COLUMN_CLAUSE_PATTERNS: Array<{
  kind: "add" | "drop" | "alter" | "rename";
  pattern: RegExp;
  nameIndex: number;
}> = [
  {
    kind: "add",
    pattern: new RegExp(`\\bADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "gi"),
    nameIndex: 1,
  },
  {
    kind: "drop",
    pattern: new RegExp(`\\bDROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "gi"),
    nameIndex: 1,
  },
  {
    kind: "alter",
    pattern: new RegExp(`\\bALTER\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "gi"),
    nameIndex: 1,
  },
  {
    kind: "rename",
    pattern: new RegExp(`\\bRENAME\\s+COLUMN\\s+(${IDENT})\\s+TO\\s+(${IDENT})`, "gi"),
    nameIndex: 1,
  },
];

// Named constraints only. The `ADD (PRIMARY KEY|UNIQUE|...)` form is matched
// separately so `ADD COLUMN` is not mistaken for a constraint.
const CONSTRAINT_ADD_PATTERN = new RegExp(
  `\\bADD\\s+CONSTRAINT\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`,
  "i",
);
const CONSTRAINT_ADD_UNNAMED_PATTERN = new RegExp(
  `\\bADD\\s+(PRIMARY\\s+KEY|UNIQUE|FOREIGN\\s+KEY|CHECK|EXCLUDE)\\b`,
  "i",
);
const CONSTRAINT_DROP_PATTERN = new RegExp(
  `\\bDROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`,
  "i",
);

const DATA_OP_PATTERNS: Array<{ op: DataOperation["op"]; pattern: RegExp }> = [
  { op: "INSERT", pattern: new RegExp(`\\bINSERT\\s+INTO\\s+${QUALIFIED}`, "i") },
  { op: "UPDATE", pattern: new RegExp(`\\bUPDATE\\s+${QUALIFIED}\\b`, "i") },
  { op: "DELETE", pattern: new RegExp(`\\bDELETE\\s+FROM\\s+${QUALIFIED}`, "i") },
  { op: "TRUNCATE", pattern: new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?${QUALIFIED}`, "i") },
];

const RENAME_TABLE_PATTERN = new RegExp(`\\bRENAME\\s+TO\\s+${QUALIFIED}`, "i");
const ATTACH_PARTITION_PATTERN = new RegExp(`\\bATTACH\\s+PARTITION\\s+${QUALIFIED}`, "i");
const DETACH_PARTITION_PATTERN = new RegExp(`\\bDETACH\\s+PARTITION\\s+${QUALIFIED}`, "i");

/** Analyze the SQL of a single migration file. */
export function analyzeMigrationSql(sql: string, name: string): MigrationImpact {
  const parsed = splitSqlStatements(sql);
  const impact: MigrationImpact = {
    version: name.replace(/\.sql$/, ""),
    name,
    creates: [],
    alters: [],
    drops: [],
    dataOps: [],
    statements: parsed.statements,
  };

  for (const statement of parsed.statements) {
    analyzeStatement(statement, impact);
  }

  return dedupeImpact(impact);
}

function analyzeStatement(statement: string, impact: MigrationImpact): void {
  for (const entry of STATEMENT_PATTERNS) {
    const match = statement.match(entry.pattern);
    if (!match) continue;
    const target: ImpactEntry = {
      type: entry.type,
      name: match[entry.nameIndex ?? 1],
    };
    if (entry.create) {
      impact.creates.push(target);
    } else {
      impact.drops.push(target);
    }
    return; // one statement, one primary effect
  }

  // ALTER TABLE — may carry multiple clauses
  const alterMatch = statement.match(ALTER_TABLE_PATTERN);
  if (alterMatch) {
    const tableName = alterMatch[1];
    analyzeAlterTable(statement, tableName, impact);
    return;
  }

  // Data operations
  for (const { op, pattern } of DATA_OP_PATTERNS) {
    const match = statement.match(pattern);
    if (match) {
      impact.dataOps.push({ op, table: match[1] });
      return;
    }
  }
}

function analyzeAlterTable(
  statement: string,
  tableName: string,
  impact: MigrationImpact,
): void {
  const tableRef: ImpactEntry = { type: "table", name: tableName };

  // RENAME TO / RENAME COLUMN / ATTACH|DETACH PARTITION
  const rename = statement.match(RENAME_TABLE_PATTERN);
  if (rename) {
    impact.alters.push({ type: "table", name: `${tableName} → ${rename[1]}` });
  }
  const attach = statement.match(ATTACH_PARTITION_PATTERN);
  if (attach) {
    impact.alters.push({ type: "table", name: `${tableName} (attach partition ${attach[1]})` });
  }
  const detach = statement.match(DETACH_PARTITION_PATTERN);
  if (detach) {
    impact.alters.push({ type: "table", name: `${tableName} (detach partition ${detach[1]})` });
  }

  let matchedClause = false;

  for (const clause of COLUMN_CLAUSE_PATTERNS) {
    for (const match of statement.matchAll(clause.pattern)) {
      matchedClause = true;
      const column = match[clause.nameIndex];
      if (clause.kind === "add") {
        impact.creates.push({ type: "column", name: `${tableName}.${column}` });
      } else if (clause.kind === "drop") {
        impact.drops.push({ type: "column", name: `${tableName}.${column}` });
      } else if (clause.kind === "rename") {
        impact.alters.push({
          type: "column",
          name: `${tableName}.${column} → ${match[2]}`,
        });
      } else {
        impact.alters.push({ type: "column", name: `${tableName}.${column}` });
      }
    }
  }

  const namedConstraint = statement.match(CONSTRAINT_ADD_PATTERN);
  if (namedConstraint) {
    matchedClause = true;
    impact.creates.push({
      type: "constraint",
      name: `${tableName}.${namedConstraint[1]}`,
    });
  } else if (CONSTRAINT_ADD_UNNAMED_PATTERN.test(statement)) {
    matchedClause = true;
    impact.creates.push({ type: "constraint", name: `${tableName}.${constraintKind(statement)}` });
  }

  const namedDrop = statement.match(CONSTRAINT_DROP_PATTERN);
  if (namedDrop) {
    matchedClause = true;
    impact.drops.push({ type: "constraint", name: `${tableName}.${namedDrop[1]}` });
  }

  if (!matchedClause) {
    impact.alters.push(tableRef);
  }
}

function constraintKind(statement: string): string {
  const match = statement.match(CONSTRAINT_ADD_UNNAMED_PATTERN);
  return match ? match[1].replace(/\s+/g, " ").toUpperCase() : "CONSTRAINT";
}

function dedupeImpact(impact: MigrationImpact): MigrationImpact {
  const dedupe = <T extends { type: string; name: string }>(entries: T[]): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const entry of entries) {
      const key = `${entry.type}:${entry.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(entry);
      }
    }
    return out;
  };
  return {
    ...impact,
    creates: dedupe(impact.creates),
    alters: dedupe(impact.alters),
    drops: dedupe(impact.drops),
  };
}

/**
 * Analyze every migration in a directory and detect cross-migration hazards.
 */
export function analyzeMigrationsDir(migrationsDir: string): ImpactReport {
  const migrations = discoverMigrations(migrationsDir);
  const impacts: MigrationImpact[] = [];
  const conflicts: ConflictFinding[] = [];

  for (const migration of migrations) {
    const sql = fs.readFileSync(migration.upPath, "utf-8");
    impacts.push(analyzeMigrationSql(sql, migration.name));
  }

  const createdBy = new Map<string, string>(); // "type:name" -> first migration name

  for (const impact of impacts) {
    // Multiple creations of the same object (usually guarded by IF NOT EXISTS,
    // but worth surfacing).
    const createCounts = new Map<string, number>();
    for (const entry of impact.creates) {
      const key = `${entry.type}:${entry.name}`;
      createCounts.set(key, (createCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of createCounts) {
      if (count > 1) {
        conflicts.push({
          severity: "info",
          kind: "REPEATED_CREATE",
          message: `Migration creates ${key} ${count} times.`,
          migrations: [impact.name],
        });
      }
    }

    for (const entry of impact.creates) {
      const key = `${entry.type}:${entry.name}`;
      const first = createdBy.get(key);
      if (first && first !== impact.name) {
        conflicts.push({
          severity: "warning",
          kind: "DUPLICATE_OBJECT_CREATE",
          message: `Object ${key} is created by both ${first} and ${impact.name}.`,
          migrations: [first, impact.name],
        });
      } else if (!first) {
        createdBy.set(key, impact.name);
      }
    }

    for (const entry of impact.drops) {
      const key = `${entry.type}:${entry.name}`;
      const creator = createdBy.get(key);
      if (!creator) {
        conflicts.push({
          severity: "warning",
          kind: "ORPHAN_DROP",
          message: `Migration drops ${key} which no earlier migration in this directory creates. It may target a table created by an unmanaged script.`,
          migrations: [impact.name],
        });
      } else {
        conflicts.push({
          severity: "info",
          kind: "REFERENTIAL_DROP",
          message: `Migration drops ${key} created by ${creator}.`,
          migrations: [creator, impact.name],
        });
      }
    }

    if (impact.dataOps.length > 0) {
      conflicts.push({
        severity: "warning",
        kind: "DATA_MODIFYING",
        message: `Migration modifies data (${impact.dataOps.map((d) => `${d.op} ${d.table}`).join(", ")}). Data migrations are irreversible once rows change; verify the rollback file restores them.`,
        migrations: [impact.name],
      });
    }
  }

  return { impacts, conflicts };
}

/** Format an impact report for human consumption (CLI output). */
export function formatImpactReport(report: ImpactReport): string {
  const lines: string[] = [
    "Migration Impact Analysis",
    "=========================",
  ];
  for (const impact of report.impacts) {
    lines.push(`\n${impact.name}`);
    if (impact.creates.length > 0) {
      lines.push(
        `  creates: ${impact.creates.map((e) => `${e.type} ${e.name}`).join(", ")}`,
      );
    }
    if (impact.alters.length > 0) {
      lines.push(
        `  alters:  ${impact.alters.map((e) => `${e.type} ${e.name}`).join(", ")}`,
      );
    }
    if (impact.drops.length > 0) {
      lines.push(
        `  drops:   ${impact.drops.map((e) => `${e.type} ${e.name}`).join(", ")}`,
      );
    }
    if (impact.dataOps.length > 0) {
      lines.push(
        `  data:    ${impact.dataOps.map((d) => `${d.op} ${d.table}`).join(", ")}`,
      );
    }
    if (
      impact.creates.length === 0 &&
      impact.alters.length === 0 &&
      impact.drops.length === 0 &&
      impact.dataOps.length === 0
    ) {
      lines.push("  (no object-level effects detected)");
    }
  }

  const conflicts = report.conflicts;
  const severityOrder = { error: 0, warning: 1, info: 2 } as const;
  conflicts.sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
  );

  lines.push("\nCross-migration findings:");
  if (conflicts.length === 0) {
    lines.push("  (none)");
  } else {
    for (const finding of conflicts) {
      lines.push(
        `  [${finding.severity.toUpperCase()}] ${finding.kind}: ${finding.message}`,
      );
    }
  }
  return lines.join("\n");
}

