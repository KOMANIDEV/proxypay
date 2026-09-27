/**
 * Unit tests for the Settings Panel utility (src/utils/settingsPanel.ts).
 *
 * Coverage:
 *   1. getSettings — returns defaults for unknown users, merges stored values
 *   2. updateSettings — applies valid patches, rejects invalid input
 *   3. resetSettings — restores defaults
 *   4. deleteSettings — removes user entry
 *   5. validateSettings — all field-level validation rules
 *   6. Persistence — disk write is called after mutations (mocked)
 *   7. SETTINGS_OPTIONS — enumerates valid values
 */

import fs from "fs";
import {
  getSettings,
  updateSettings,
  resetSettings,
  deleteSettings,
  validateSettings,
  resolveSettingsConflict,
  onSettingsChanged,
  SETTINGS_OPTIONS,
  DEFAULT_SETTINGS,
  _resetStoreForTesting,
} from "../settingsPanel";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// Mock fs so no real files are written during tests.
jest.mock("fs", () => {
  const actual = jest.requireActual<typeof fs>("fs");
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn(),
    writeFile: jest.fn(
      (_p: unknown, _d: unknown, _e: unknown, cb: () => void) => cb(),
    ),
    mkdirSync: jest.fn(),
  };
});

beforeEach(() => {
  _resetStoreForTesting();
  jest.clearAllMocks();
  (fs.existsSync as jest.Mock).mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// 1. getSettings
// ---------------------------------------------------------------------------

describe("getSettings", () => {
  it("returns default settings for an unknown user", () => {
    const settings = getSettings("user-unknown");
    expect(settings.theme).toBe("system");
    expect(settings.currency).toBe("USD");
    expect(settings.notifications.toastDensity).toBe("comfortable");
    expect(settings.notifications.quietMode).toBe(false);
  });

  it("returns a deep clone — mutations do not affect the store", () => {
    const s1 = getSettings("user-clone");
    s1.theme = "dark";
    const s2 = getSettings("user-clone");
    expect(s2.theme).toBe("system"); // still default
  });

  it("merges stored values over defaults", () => {
    updateSettings("user-merge", { theme: "dark", currency: "EUR" });
    const settings = getSettings("user-merge");
    expect(settings.theme).toBe("dark");
    expect(settings.currency).toBe("EUR");
    // Untouched fields keep defaults
    expect(settings.notifications.quietMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. updateSettings
// ---------------------------------------------------------------------------

describe("updateSettings", () => {
  it("applies a theme patch", () => {
    const result = updateSettings("user-theme", { theme: "light" });
    expect("settings" in result).toBe(true);
    if ("settings" in result) {
      expect(result.settings.theme).toBe("light");
    }
  });

  it("normalises currency to uppercase", () => {
    const result = updateSettings("user-currency", { currency: "xaf" });
    expect("settings" in result).toBe(true);
    if ("settings" in result) {
      expect(result.settings.currency).toBe("XAF");
    }
  });

  it("applies notification patches without touching other fields", () => {
    updateSettings("user-notif", { theme: "dark" });
    const result = updateSettings("user-notif", {
      notifications: { quietMode: true },
    });
    expect("settings" in result).toBe(true);
    if ("settings" in result) {
      expect(result.settings.notifications.quietMode).toBe(true);
      expect(result.settings.theme).toBe("dark"); // preserved
    }
  });

  it("sets updatedAt to a recent ISO timestamp", () => {
    const before = Date.now();
    const result = updateSettings("user-ts", { theme: "dark" });
    const after = Date.now();
    if ("settings" in result) {
      const ts = new Date(result.settings.updatedAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    }
  });

  it("returns validation errors for an invalid theme", () => {
    const result = updateSettings("user-bad-theme", {
      theme: "rainbow" as never,
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].field).toBe("theme");
    }
  });

  it("returns validation errors for an invalid currency", () => {
    const result = updateSettings("user-bad-currency", {
      currency: "INVALID",
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].field).toBe("currency");
    }
  });

  it("returns validation errors for an invalid toastDensity", () => {
    const result = updateSettings("user-bad-density", {
      notifications: { toastDensity: "ultra" as never },
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].field).toBe("notifications.toastDensity");
    }
  });

  it("returns validation errors for a non-boolean quietMode", () => {
    const result = updateSettings("user-bad-quiet", {
      notifications: { quietMode: "yes" as never },
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].field).toBe("notifications.quietMode");
    }
  });

  it("accumulates multiple validation errors", () => {
    const result = updateSettings("user-multi-err", {
      theme: "neon" as never,
      currency: "TOOLONG",
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("calls fs.writeFile after a successful update", () => {
    updateSettings("user-persist", { theme: "dark" });
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it("does NOT call fs.writeFile when validation fails", () => {
    updateSettings("user-no-persist", { theme: "bad" as never });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. resetSettings
// ---------------------------------------------------------------------------

describe("resetSettings", () => {
  it("restores all fields to defaults", () => {
    updateSettings("user-reset", {
      theme: "dark",
      currency: "EUR",
      notifications: { quietMode: true, toastDensity: "minimal" },
    });

    const settings = resetSettings("user-reset");
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(settings.currency).toBe(DEFAULT_SETTINGS.currency);
    expect(settings.notifications.quietMode).toBe(
      DEFAULT_SETTINGS.notifications.quietMode,
    );
    expect(settings.notifications.toastDensity).toBe(
      DEFAULT_SETTINGS.notifications.toastDensity,
    );
  });

  it("sets updatedAt to a recent timestamp on reset", () => {
    const before = Date.now();
    const settings = resetSettings("user-reset-ts");
    const after = Date.now();
    const ts = new Date(settings.updatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("persists the reset to disk", () => {
    resetSettings("user-reset-persist");
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. deleteSettings
// ---------------------------------------------------------------------------

describe("deleteSettings", () => {
  it("removes the user entry so subsequent reads return defaults", () => {
    updateSettings("user-delete", { theme: "dark" });
    deleteSettings("user-delete");
    const settings = getSettings("user-delete");
    expect(settings.theme).toBe("system");
  });

  it("persists the deletion to disk", () => {
    deleteSettings("user-delete-persist");
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. validateSettings (standalone)
// ---------------------------------------------------------------------------

describe("validateSettings", () => {
  it("returns no errors for a valid full patch", () => {
    const errors = validateSettings({
      theme: "dark",
      currency: "GBP",
      notifications: { toastDensity: "compact", quietMode: true },
    });
    expect(errors).toHaveLength(0);
  });

  it("returns no errors for an empty patch", () => {
    expect(validateSettings({})).toHaveLength(0);
  });

  it("validates all three theme values", () => {
    for (const theme of ["light", "dark", "system"] as const) {
      expect(validateSettings({ theme })).toHaveLength(0);
    }
  });

  it("validates all three toastDensity values", () => {
    for (const toastDensity of ["comfortable", "compact", "minimal"] as const) {
      expect(
        validateSettings({ notifications: { toastDensity } }),
      ).toHaveLength(0);
    }
  });

  it("rejects a 2-letter currency code", () => {
    const errors = validateSettings({ currency: "US" });
    expect(errors.some((e) => e.field === "currency")).toBe(true);
  });

  it("rejects a 4-letter currency code", () => {
    const errors = validateSettings({ currency: "USDD" });
    expect(errors.some((e) => e.field === "currency")).toBe(true);
  });

  it("accepts lowercase currency and normalises it", () => {
    // validateSettings only checks format; normalisation happens in updateSettings
    const errors = validateSettings({ currency: "eur" });
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. SETTINGS_OPTIONS
// ---------------------------------------------------------------------------

describe("SETTINGS_OPTIONS", () => {
  it("exposes all valid themes", () => {
    expect(SETTINGS_OPTIONS.themes).toEqual(
      expect.arrayContaining(["light", "dark", "system"]),
    );
  });

  it("exposes all valid toastDensities", () => {
    expect(SETTINGS_OPTIONS.toastDensities).toEqual(
      expect.arrayContaining(["comfortable", "compact", "minimal"]),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Versioning & concurrency control
// ---------------------------------------------------------------------------

describe("versioning", () => {
  it("starts at version 0 for an unknown user", () => {
    expect(getSettings("user-v0").version).toBe(0);
  });

  it("increments the version on every successful update", () => {
    updateSettings("user-v1", { theme: "dark" });
    expect(getSettings("user-v1").version).toBe(1);
    updateSettings("user-v1", { currency: "EUR" });
    expect(getSettings("user-v1").version).toBe(2);
  });

  it("does not increment the version when validation fails", () => {
    updateSettings("user-vbad", { theme: "dark" });
    updateSettings("user-vbad", { theme: "rainbow" as never });
    expect(getSettings("user-vbad").version).toBe(1);
  });

  it("applies an update when expectedVersion matches", () => {
    updateSettings("user-ok", { theme: "dark" }); // version 1
    const result = updateSettings(
      "user-ok",
      { currency: "EUR" },
      {
        expectedVersion: 1,
      },
    );
    expect("settings" in result).toBe(true);
    if ("settings" in result) {
      expect(result.settings.currency).toBe("EUR");
      expect(result.settings.version).toBe(2);
    }
  });

  it("rejects the update with a conflict when expectedVersion is stale", () => {
    updateSettings("user-conflict", { theme: "dark" }); // version 1
    // A second session writes first, bumping to version 2.
    updateSettings("user-conflict", { currency: "EUR" }); // version 2

    const result = updateSettings(
      "user-conflict",
      { theme: "light" },
      {
        expectedVersion: 1, // stale
      },
    );
    expect("conflict" in result).toBe(true);
    if ("conflict" in result) {
      expect(result.current.version).toBe(2);
      expect(result.current.currency).toBe("EUR");
    }
    // Nothing was clobbered.
    expect(getSettings("user-conflict").theme).toBe("dark");
  });

  it("resolveSettingsConflict server-wins keeps stored values but advances the version", () => {
    updateSettings("user-sw", { theme: "dark" }); // version 1
    const result = resolveSettingsConflict(
      "user-sw",
      { theme: "light" },
      "server-wins",
    );
    expect("settings" in result).toBe(true);
    if ("settings" in result) {
      expect(result.settings.theme).toBe("dark"); // server value kept
      expect(result.settings.version).toBe(2);
    }
  });

  it("resolveSettingsConflict client-wins applies the incoming patch", () => {
    updateSettings("user-cw", { theme: "dark" }); // version 1
    const result = resolveSettingsConflict(
      "user-cw",
      { theme: "light" },
      "client-wins",
    );
    expect("settings" in result).toBe(true);
    if ("settings" in result) {
      expect(result.settings.theme).toBe("light");
      expect(result.settings.version).toBe(2);
    }
  });

  it("resolveSettingsConflict merge keeps untouched fields from the server", () => {
    updateSettings("user-merge2", { theme: "dark", currency: "EUR" }); // version 1
    const result = resolveSettingsConflict(
      "user-merge2",
      { theme: "light" },
      "merge",
    );
    expect("settings" in result).toBe(true);
    if ("settings" in result) {
      expect(result.settings.theme).toBe("light"); // from patch
      expect(result.settings.currency).toBe("EUR"); // kept from server
    }
  });

  it("resetSettings advances the version", () => {
    updateSettings("user-reset-v", { theme: "dark" }); // version 1
    const settings = resetSettings("user-reset-v");
    expect(settings.version).toBe(2);
  });

  it("emits a change event after a successful update", () => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = onSettingsChanged((event) => events.push(event));
    try {
      updateSettings("user-evt", { theme: "dark" }, { source: "test" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        userId: "user-evt",
        action: "update",
        previousVersion: 0,
        newVersion: 1,
        source: "test",
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not emit a change event when validation fails", () => {
    const listener = jest.fn();
    const unsubscribe = onSettingsChanged(listener);
    try {
      updateSettings("user-noevt", { theme: "bad" as never });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Disk hydration
// ---------------------------------------------------------------------------

describe("disk hydration", () => {
  it("loads persisted settings from disk on first access", () => {
    const stored = {
      "user-hydrate": {
        theme: "dark",
        currency: "EUR",
        notifications: { toastDensity: "compact", quietMode: true },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(stored));

    const settings = getSettings("user-hydrate");
    expect(settings.theme).toBe("dark");
    expect(settings.currency).toBe("EUR");
    expect(settings.notifications.quietMode).toBe(true);
  });

  it("handles a corrupt settings file gracefully", () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue("not-valid-json{{");

    expect(() => getSettings("user-corrupt")).not.toThrow();
    const settings = getSettings("user-corrupt");
    expect(settings.theme).toBe("system"); // falls back to defaults
  });
});
