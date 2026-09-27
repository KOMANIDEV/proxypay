/**
 * Data migration script that re-encrypts PII ciphertext with the configured
 * active key version.
 *
 * Run this after provisioning a new key version (`PII_ENCRYPTION_KEY_<VERSION>`
 * / `PII_ENCRYPTION_KEYS`) and pointing `ACTIVE_PII_KEY_VERSION` at it. Old
 * versions must stay in the key ring until the migration completes so rows that
 * have not been visited yet remain readable.
 *
 * Usage:
 *   npx tsx src/scripts/rotate-encryption-keys.ts --dry-run
 *   npx tsx src/scripts/rotate-encryption-keys.ts --target-version=v2
 *   npx tsx src/scripts/rotate-encryption-keys.ts --table=users --column=email
 *
 * Flags:
 *   --target-version=<v>  Key version to re-encrypt with (defaults to the
 *                         active version resolved from ACTIVE_PII_KEY_VERSION).
 *   --table=<name>        Restrict the migration to a single table.
 *   --column=<name>       Restrict the migration to a single column.
 *   --batch-size=<n>      Rows fetched per batch (default 500).
 *   --limit=<n>           Maximum rows processed per target (default: all).
 *   --dry-run             Report what would change without writing.
 *
 * WARNING: This migration rewrites encrypted columns in place. Create a backup
 * before running it and verify decryption with the previous key ring first.
 */

import { queryRead, queryWrite } from "../config/database";
import {
  getActiveKeyVersion,
  rotateCiphertext,
  validateKeyRingConfig,
} from "../crypto/encryption";
import logger from "../utils/logger";

export interface RotationTarget {
  table: string;
  column: string;
  idColumn?: string;
}

export interface RotationTargetStats {
  table: string;
  column: string;
  scanned: number;
  rotated: number;
  skipped: number;
  failed: number;
}

export interface RotationSummary {
  targetVersion: string;
  dryRun: boolean;
  totalScanned: number;
  totalRotated: number;
  totalSkipped: number;
  totalFailed: number;
  targets: RotationTargetStats[];
}

export interface RotationOptions {
  targetVersion?: string;
  targets?: RotationTarget[];
  batchSize?: number;
  limit?: number;
  dryRun?: boolean;
}

/** Columns that store versioned PII ciphertext and must follow key rotations. */
export const DEFAULT_ROTATION_TARGETS: RotationTarget[] = [
  { table: "transactions", column: "phone_number" },
  { table: "transactions", column: "stellar_address" },
  { table: "transactions", column: "notes" },
];

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/i;

function assertIdentifier(value: string, kind: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid SQL ${kind}: "${value}"`);
  }
  return value;
}

/** Parses `--key=value` / `--flag` argv entries into rotation options. */
export function parseRotationArgs(argv: string[]): RotationOptions {
  const options: RotationOptions = {};

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();

    switch (key) {
      case "target-version":
        if (value) options.targetVersion = value;
        break;
      case "batch-size":
        options.batchSize = Number.parseInt(value, 10);
        break;
      case "limit":
        options.limit = Number.parseInt(value, 10);
        break;
      case "table":
        options.targets = [
          { table: assertIdentifier(value, "table"), column: "" },
        ];
        break;
      case "column":
        if (!options.targets?.length) {
          options.targets = [
            { table: "", column: assertIdentifier(value, "column") },
          ];
        } else {
          options.targets[0].column = assertIdentifier(value, "column");
        }
        break;
      default:
        break;
    }
  }

  return options;
}

/**
 * Reads `KEY_ROTATION_TARGETS` (JSON array) when set, otherwise falls back to
 * {@link DEFAULT_ROTATION_TARGETS}. Exposed for tests.
 */
export function resolveRotationTargets(
  overrides?: RotationTarget[],
): RotationTarget[] {
  if (overrides && overrides.length > 0) return overrides;

  const raw = process.env.KEY_ROTATION_TARGETS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RotationTarget[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (err) {
      logger.error(err, "Failed to parse KEY_ROTATION_TARGETS; using defaults");
    }
  }

  return DEFAULT_ROTATION_TARGETS;
}

async function rotateTarget(
  target: RotationTarget,
  targetVersion: string,
  batchSize: number,
  limit: number | undefined,
  dryRun: boolean,
): Promise<RotationTargetStats> {
  const stats: RotationTargetStats = {
    table: target.table,
    column: target.column,
    scanned: 0,
    rotated: 0,
    skipped: 0,
    failed: 0,
  };

  if (!target.table || !target.column) {
    throw new Error("Rotation target requires both `table` and `column`.");
  }

  const table = assertIdentifier(target.table, "table");
  const column = assertIdentifier(target.column, "column");
  const idColumn = assertIdentifier(target.idColumn ?? "id", "identifier");
  const maxRows = limit ?? Number.POSITIVE_INFINITY;

  let lastId: string | null = null;

  while (stats.scanned < maxRows) {
    const remaining = Math.min(batchSize, maxRows - stats.scanned);
    const rows = lastId
      ? await queryRead(
          `SELECT ${idColumn} AS id, ${column} AS value FROM ${table}
           WHERE ${column} IS NOT NULL AND ${idColumn} > $1
           ORDER BY ${idColumn} LIMIT $2`,
          [lastId, remaining],
        )
      : await queryRead(
          `SELECT ${idColumn} AS id, ${column} AS value FROM ${table}
           WHERE ${column} IS NOT NULL
           ORDER BY ${idColumn} LIMIT $1`,
          [remaining],
        );

    if (rows.rows.length === 0) break;

    for (const row of rows.rows) {
      stats.scanned++;
      lastId = String(row.id);

      try {
        const result = rotateCiphertext(String(row.value), targetVersion);

        if (!result.rotated) {
          stats.skipped++;
          continue;
        }

        if (!dryRun) {
          await queryWrite(
            `UPDATE ${table} SET ${column} = $1 WHERE ${idColumn} = $2`,
            [result.value, row.id],
          );
        }

        stats.rotated++;
        logger.debug(
          `Rotated ${table}.${column} for ${row.id} (${result.fromVersion ?? "legacy"} -> ${result.toVersion})`,
        );
      } catch (error) {
        stats.failed++;
        logger.error(
          error,
          `Failed to rotate ${table}.${column} for ${row.id}`,
        );
      }
    }

    if (rows.rows.length < remaining) break;
  }

  return stats;
}

/**
 * Re-encrypts every configured PII column with the target key version.
 * Idempotent: rows already on the target version are skipped.
 */
export async function rotateEncryptionKeys(
  options: RotationOptions = {},
): Promise<RotationSummary> {
  const config = validateKeyRingConfig();
  if (!config.valid) {
    throw new Error(
      `Invalid key ring configuration: ${config.errors.join("; ")}`,
    );
  }

  const targetVersion = (
    options.targetVersion ?? getActiveKeyVersion()
  ).toLowerCase();
  const targets = resolveRotationTargets(options.targets);
  const batchSize =
    options.batchSize && options.batchSize > 0 ? options.batchSize : 500;
  const dryRun = options.dryRun ?? false;

  const summary: RotationSummary = {
    targetVersion,
    dryRun,
    totalScanned: 0,
    totalRotated: 0,
    totalSkipped: 0,
    totalFailed: 0,
    targets: [],
  };

  for (const target of targets) {
    const stats = await rotateTarget(
      target,
      targetVersion,
      batchSize,
      options.limit,
      dryRun,
    );

    summary.targets.push(stats);
    summary.totalScanned += stats.scanned;
    summary.totalRotated += stats.rotated;
    summary.totalSkipped += stats.skipped;
    summary.totalFailed += stats.failed;
  }

  return summary;
}

async function main(): Promise<void> {
  const options = parseRotationArgs(process.argv.slice(2));
  logger.info(
    `Starting encryption key rotation${options.dryRun ? " (dry run)" : ""}...`,
  );

  const summary = await rotateEncryptionKeys(options);

  for (const target of summary.targets) {
    logger.info(
      `${target.table}.${target.column}: ${target.rotated} rotated, ${target.skipped} already current, ${target.failed} failed`,
    );
  }

  logger.info(
    `Key rotation complete -> ${summary.targetVersion}: ${summary.totalRotated} rotated, ${summary.totalSkipped} skipped, ${summary.totalFailed} failed (${summary.totalScanned} scanned)`,
  );

  if (summary.totalFailed > 0) {
    logger.warn(
      `Rotation finished with ${summary.totalFailed} failures. Check logs.`,
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Key rotation migration failed:", error);
    process.exit(1);
  });
}
