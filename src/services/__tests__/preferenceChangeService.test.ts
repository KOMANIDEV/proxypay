/**
 * Unit tests for the Preference Change Service.
 *
 * Coverage:
 *   1. recordPreferenceChange – audit trail persistence
 *   2. getPreferenceChangeHistory – paged history queries
 *   3. enqueuePreferenceWebhook – webhook_outbox enqueueing
 *   4. createPreferenceChangeHandler – listener wiring
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  recordPreferenceChange,
  getPreferenceChangeHistory,
  enqueuePreferenceWebhook,
  createPreferenceChangeHandler,
} from "../preferenceChangeService";
import type { SettingsChangeEvent } from "../../utils/settingsPanel";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { pool } from "../../config/database";

const mockQuery = pool.query as jest.Mock;

const EVENT: SettingsChangeEvent = {
  userId: "user-1",
  actorId: "user-1",
  action: "update",
  previousVersion: 2,
  newVersion: 3,
  changes: { theme: "dark" },
  source: "api",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe("recordPreferenceChange", () => {
  it("inserts an audit entry with the version transition", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "log-1",
          user_id: "user-1",
          actor_id: "user-1",
          action: "update",
          previous_version: 2,
          new_version: 3,
          changes: { theme: "dark" },
          source: "api",
          created_at: new Date("2026-08-25T10:00:00Z"),
        },
      ],
    });

    const entry = await recordPreferenceChange(EVENT);
    expect(entry.previousVersion).toBe(2);
    expect(entry.newVersion).toBe(3);
    expect(entry.action).toBe("update");
    expect(mockQuery.mock.calls[0][1]).toEqual([
      "user-1",
      "user-1",
      "update",
      2,
      3,
      JSON.stringify({ theme: "dark" }),
      "api",
    ]);
  });
});

describe("getPreferenceChangeHistory", () => {
  it("returns entries and total, newest first", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "log-2",
            user_id: "user-1",
            actor_id: null,
            action: "reset",
            previous_version: 3,
            new_version: 4,
            changes: { reset: true },
            source: "api",
            created_at: new Date("2026-08-25T11:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const result = await getPreferenceChangeHistory("user-1");
    expect(result.total).toBe(1);
    expect(result.entries[0].action).toBe("reset");
    expect(result.entries[0].newVersion).toBe(4);
  });

  it("clamps the limit and offset", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await getPreferenceChangeHistory("user-1", 9999, -5);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(["user-1", 200, 0]); // capped limit, floored offset
  });
});

describe("enqueuePreferenceWebhook", () => {
  it("inserts a preference.changed entry into webhook_outbox", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "outbox-1" }] });

    const id = await enqueuePreferenceWebhook(EVENT);
    expect(id).toBe("outbox-1");

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("webhook_outbox");
    expect(params[0]).toBe("preference.changed");
    const payload = JSON.parse(params[1]);
    expect(payload.event_type).toBe("preference.changed");
    expect(payload.data.user_id).toBe("user-1");
    expect(payload.data.previous_version).toBe(2);
    expect(payload.data.new_version).toBe(3);
  });

  it("returns null when the insert fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    const id = await enqueuePreferenceWebhook(EVENT).catch(() => null);
    expect(id).toBeNull();
  });
});

describe("createPreferenceChangeHandler", () => {
  it("records the change for every emitted settings event", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "log-3",
          user_id: "user-1",
          actor_id: null,
          action: "update",
          previous_version: 1,
          new_version: 2,
          changes: {},
          source: "api",
          created_at: new Date(),
        },
      ],
    });

    const handler = createPreferenceChangeHandler();
    handler(EVENT);

    // The handler is fire-and-forget; allow the promise chain to run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockQuery.mock.calls.length).toBeGreaterThan(0);
  });
});
