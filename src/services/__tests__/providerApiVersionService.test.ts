/**
 * #484 – Provider Contract Version Management
 *
 * Covers version comparison, request formatting, the lifecycle notification
 * path and the compatibility rules. The persistence layer is mocked.
 */

import {
  compareVersions,
  formatRequest,
  buildVersionHeaders,
  registerProviderVersion,
  validateCompatibility,
  emitVersionEvent,
  getProviderVersion,
  setVersionStatus,
  listProviderVersions,
} from "../providerApiVersionService";
import { queryRead, queryWrite } from "../../config/database";

jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

const mockedQueryRead = queryRead as jest.Mock;
const mockedQueryWrite = queryWrite as jest.Mock;

const versionRow = (overrides: Record<string, any> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  provider: "mtn",
  version: "2.0.0",
  status: "active",
  request_format: {},
  changelog: null,
  effective_from: new Date(),
  deprecated_at: null,
  sunset_at: null,
  created_at: new Date(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("compareVersions", () => {
  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("2.10.0", "2.9.0")).toBe(1);
    expect(compareVersions("2.9.0", "2.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("tolerates a leading v and pre-release suffixes", () => {
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0-rc1", "1.2.0")).toBe(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1.1", "1.1.0")).toBe(0);
    expect(compareVersions("1.2", "1.1.9")).toBe(1);
  });
});

describe("formatRequest", () => {
  it("renames legacy fields without mutating the input", () => {
    const payload = { reference: "r1", amount: 100 };
    const formatted = formatRequest(payload, { renameFields: { reference: "referenceNumber" } });

    expect(formatted).toEqual({ referenceNumber: "r1", amount: 100 });
    expect(payload).toEqual({ reference: "r1", amount: 100 });
  });

  it("drops fields the version no longer accepts", () => {
    expect(
      formatRequest({ a: 1, legacy: 2, b: 3 }, { dropFields: ["legacy"] }),
    ).toEqual({ a: 1, b: 3 });
  });

  it("injects defaults only for absent fields", () => {
    expect(
      formatRequest(
        { currency: "USD" },
        { defaults: { currency: "GHS", callbackUrl: "https://bridge/x" } },
      ),
    ).toEqual({ currency: "USD", callbackUrl: "https://bridge/x" });
  });

  it("wraps the payload in the configured envelope", () => {
    expect(formatRequest({ amount: 5 }, { envelope: "data" })).toEqual({
      data: { amount: 5 },
    });
  });

  it("supports null envelope (no wrapping)", () => {
    expect(formatRequest({ amount: 5 }, { envelope: null })).toEqual({ amount: 5 });
  });

  it("does not overwrite an existing value during a rename", () => {
    expect(
      formatRequest(
        { old: "1", current: "2" },
        { renameFields: { old: "current" } },
      ),
    ).toEqual({ current: "2" });
  });
});

describe("buildVersionHeaders", () => {
  it("returns a copy of the configured headers", () => {
    const headers = buildVersionHeaders({ header: { "X-Api-Version": "2.0" } });
    expect(headers).toEqual({ "X-Api-Version": "2.0" });
  });

  it("returns an empty object when no headers are configured", () => {
    expect(buildVersionHeaders({})).toEqual({});
  });
});

describe("registerProviderVersion", () => {
  it("persists the version and records a registered event", async () => {
    mockedQueryWrite
      .mockResolvedValueOnce({ rows: [versionRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const record = await registerProviderVersion({
      provider: "mtn",
      version: "2.0.0",
      requestFormat: { envelope: "data" },
    });

    expect(record.version).toBe("2.0.0");
    expect(record.status).toBe("active");
    expect(mockedQueryWrite).toHaveBeenCalledTimes(2);
    expect(mockedQueryWrite.mock.calls[1][0]).toContain(
      "provider_api_version_events",
    );
  });
});

describe("validateCompatibility", () => {
  it("accepts a registered, non-retired version", async () => {
    mockedQueryRead.mockResolvedValueOnce({ rows: [versionRow()] });

    const result = await validateCompatibility("mtn", "2.0.0", "1.0.0");

    expect(result.compatible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects an unregistered version", async () => {
    mockedQueryRead.mockResolvedValueOnce({ rows: [] });

    const result = await validateCompatibility("mtn", "9.9.9", "1.0.0");

    expect(result.compatible).toBe(false);
    expect(result.reasons[0]).toContain("not registered");
  });

  it("rejects a retired version", async () => {
    mockedQueryRead.mockResolvedValueOnce({
      rows: [versionRow({ status: "retired" })],
    });

    const result = await validateCompatibility("mtn", "2.0.0", "1.0.0");

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(" ")).toContain("retired");
  });

  it("rejects a version past its sunset date", async () => {
    mockedQueryRead.mockResolvedValueOnce({
      rows: [
        versionRow({
          status: "deprecated",
          sunset_at: new Date(Date.now() - 86_400_000),
        }),
      ],
    });

    const result = await validateCompatibility("mtn", "2.0.0", "1.0.0");

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(" ")).toContain("sunset");
  });

  it("honours the grace period before the sunset date bites", async () => {
    mockedQueryRead.mockResolvedValueOnce({
      rows: [
        versionRow({
          status: "deprecated",
          sunset_at: new Date(Date.now() - 3_600_000),
        }),
      ],
    });

    const result = await validateCompatibility("mtn", "2.0.0", "1.0.0", {
      graceHours: 24,
    });

    expect(result.compatible).toBe(true);
  });

  it("rejects an explicitly declared incompatibility", async () => {
    mockedQueryRead
      .mockResolvedValueOnce({ rows: [versionRow()] })
      .mockResolvedValueOnce({
        rows: [{ compatible: false, constraints: {} }],
      });

    const result = await validateCompatibility("mtn", "2.0.0", "1.0.0");

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(" ")).toContain("Declared incompatible");
  });

  it("enforces a maximum supported bridge version", async () => {
    mockedQueryRead
      .mockResolvedValueOnce({ rows: [versionRow()] })
      .mockResolvedValueOnce({
        rows: [{ compatible: true, constraints: { maxBridgeVersion: "1.5.0" } }],
      });

    const result = await validateCompatibility("mtn", "2.0.0", "2.0.0");

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(" ")).toContain("exceeds supported maximum");
  });

  it("enforces a minimum supported bridge version", async () => {
    mockedQueryRead
      .mockResolvedValueOnce({ rows: [versionRow()] })
      .mockResolvedValueOnce({
        rows: [{ compatible: true, constraints: { minBridgeVersion: "1.2.0" } }],
      });

    const result = await validateCompatibility("mtn", "2.0.0", "1.0.0");

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(" ")).toContain("below supported minimum");
  });
});

describe("setVersionStatus", () => {
  it("deprecates a version and records the event", async () => {
    mockedQueryWrite
      .mockResolvedValueOnce({
        rows: [versionRow({ status: "deprecated", deprecated_at: new Date() })],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const record = await setVersionStatus("mtn", "2.0.0", "deprecated", {
      sunsetAt: new Date("2026-12-31"),
    });

    expect(record?.status).toBe("deprecated");
    expect(mockedQueryWrite.mock.calls[0][2]).toBe("deprecated");
  });

  it("returns null for an unknown version", async () => {
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(
      setVersionStatus("mtn", "3.0.0", "retired"),
    ).resolves.toBeNull();
  });
});

describe("emitVersionEvent", () => {
  it("persists the event and reports no delivery when no webhook is configured", async () => {
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 1 });

    const event = await emitVersionEvent({
      provider: "mtn",
      version: "2.0.0",
      eventType: "deprecated",
      payload: {},
    });

    expect(event.delivered).toBe(false);
    expect(mockedQueryWrite).toHaveBeenCalledTimes(1);
  });
});

describe("getProviderVersion / listProviderVersions", () => {
  it("maps a stored row onto the domain type", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [versionRow()] });

    const record = await getProviderVersion("mtn", "2.0.0");

    expect(record?.provider).toBe("mtn");
    expect(record?.isActive).toBeUndefined();
    expect(record?.status).toBe("active");
  });

  it("returns null when the version does not exist", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [] });

    await expect(getProviderVersion("mtn", "9.9.9")).resolves.toBeNull();
  });

  it("lists every version when no provider filter is given", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [versionRow(), versionRow({ version: "1.0.0" })] });

    const versions = await listProviderVersions();

    expect(versions.map((v) => v.version)).toEqual(["2.0.0", "1.0.0"]);
  });
});
