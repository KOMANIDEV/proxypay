jest.mock("../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

import { queryRead, queryWrite } from "../../src/config/database";
import {
  parseRotationArgs,
  resolveRotationTargets,
  rotateEncryptionKeys,
} from "../../src/scripts/rotate-encryption-keys";
import { encryptVersioned } from "../../src/crypto/encryption";

const mockedQueryRead = queryRead as jest.MockedFunction<typeof queryRead>;
const mockedQueryWrite = queryWrite as jest.MockedFunction<typeof queryWrite>;

const ORIGINAL_ENV = { ...process.env };
const KEY_V1 = "migration-key-v1-material-32-chars";
const KEY_V2 = "migration-key-v2-material-32-chars";

function mockRows(rows: Array<{ id: string; value: string }>): void {
  mockedQueryRead.mockResolvedValueOnce({ rows } as never);
}

describe("rotate-encryption-keys migration script", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PII_ENCRYPTION_KEYS = JSON.stringify({
      v1: KEY_V1,
      v2: KEY_V2,
    });
    process.env.ACTIVE_PII_KEY_VERSION = "v2";
    delete process.env.KEY_ROTATION_TARGETS;
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe("parseRotationArgs", () => {
    it("parses flags into rotation options", () => {
      const options = parseRotationArgs([
        "--target-version=v3",
        "--batch-size=25",
        "--limit=100",
        "--dry-run",
      ]);

      expect(options).toEqual({
        targetVersion: "v3",
        batchSize: 25,
        limit: 100,
        dryRun: true,
      });
    });

    it("builds a single target from --table / --column", () => {
      const options = parseRotationArgs(["--table=users", "--column=email"]);
      expect(options.targets).toEqual([{ table: "users", column: "email" }]);
    });

    it("rejects unsafe SQL identifiers", () => {
      expect(() =>
        parseRotationArgs(["--table=users; DROP TABLE users"]),
      ).toThrow(/Invalid SQL table/);
    });

    it("ignores unknown flags", () => {
      expect(parseRotationArgs(["--unknown=value"])).toEqual({});
    });
  });

  describe("resolveRotationTargets", () => {
    it("prefers explicit targets, then env config, then defaults", () => {
      const explicit = [{ table: "a", column: "b" }];
      expect(resolveRotationTargets(explicit)).toEqual(explicit);

      process.env.KEY_ROTATION_TARGETS = JSON.stringify([
        { table: "users", column: "email" },
      ]);
      expect(resolveRotationTargets()).toEqual([
        { table: "users", column: "email" },
      ]);

      delete process.env.KEY_ROTATION_TARGETS;
      expect(resolveRotationTargets().length).toBeGreaterThan(0);
    });
  });

  describe("rotateEncryptionKeys", () => {
    it("rotates stale rows, skips current ones and writes new ciphertext", async () => {
      const stale = encryptVersioned("phone-1", "v1");
      const current = encryptVersioned("phone-2", "v2");
      mockRows([
        { id: "1", value: stale },
        { id: "2", value: current },
      ]);

      const summary = await rotateEncryptionKeys({
        targets: [{ table: "transactions", column: "phone_number" }],
      });

      expect(summary.targetVersion).toBe("v2");
      expect(summary.totalScanned).toBe(2);
      expect(summary.totalRotated).toBe(1);
      expect(summary.totalSkipped).toBe(1);
      expect(summary.totalFailed).toBe(0);
      expect(mockedQueryWrite).toHaveBeenCalledTimes(1);

      const [sql, params] = mockedQueryWrite.mock.calls[0];
      expect(sql).toContain("UPDATE transactions SET phone_number");
      expect(String(params[0]).startsWith("v2:")).toBe(true);
      expect(params[1]).toBe("1");
    });

    it("does not write when running a dry run", async () => {
      mockRows([{ id: "1", value: encryptVersioned("phone-1", "v1") }]);

      const summary = await rotateEncryptionKeys({
        targets: [{ table: "transactions", column: "phone_number" }],
        dryRun: true,
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.totalRotated).toBe(1);
      expect(mockedQueryWrite).not.toHaveBeenCalled();
    });

    it("counts unreadable rows as failures without aborting the migration", async () => {
      mockRows([
        { id: "1", value: "not:encrypted:data" },
        { id: "2", value: encryptVersioned("phone-2", "v1") },
      ]);

      const summary = await rotateEncryptionKeys({
        targets: [{ table: "transactions", column: "phone_number" }],
      });

      expect(summary.totalFailed).toBe(1);
      expect(summary.totalRotated).toBe(1);
    });

    it("rejects an invalid key ring configuration", async () => {
      process.env.PII_ENCRYPTION_KEYS = "{}";
      delete process.env.PII_ENCRYPTION_KEY;
      delete process.env.DB_ENCRYPTION_KEY;
      delete process.env.ACTIVE_PII_KEY_VERSION;

      await expect(rotateEncryptionKeys({ targets: [] })).rejects.toThrow(
        /Invalid key ring configuration/,
      );
    });
  });
});
