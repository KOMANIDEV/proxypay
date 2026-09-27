/**
 * Tests for dashboard configuration utilities — Issue #423
 * Dashboard Widget Customization: drag/drop, visibility, refresh rates, CRUD
 */

import {
  DashboardConfig,
  DashboardWidget,
  validateDashboardConfig,
  createDefaultDashboardConfig,
  reorderWidgets,
  toggleWidgetVisibility,
  setWidgetRefreshRate,
  addWidget,
  removeWidget,
  updateWidget,
} from "../../src/utils/dashboardConfig";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeWidget = (overrides: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id: "w1",
  type: "chart",
  position: 0,
  size: "medium",
  visible: true,
  ...overrides,
});

const makeConfig = (widgets: DashboardWidget[] = []): DashboardConfig => ({
  layout: "grid",
  widgets,
});

// ---------------------------------------------------------------------------
// validateDashboardConfig
// ---------------------------------------------------------------------------

describe("validateDashboardConfig", () => {
  it("accepts a valid config with no widgets", () => {
    const config = { layout: "grid", widgets: [] };
    expect(validateDashboardConfig(config)).toBe(true);
  });

  it("accepts a valid config with widgets", () => {
    const config = makeConfig([
      makeWidget({ id: "w1", position: 0 }),
      makeWidget({ id: "w2", position: 1, size: "large", visible: false }),
    ]);
    expect(validateDashboardConfig(config)).toBe(true);
  });

  it("accepts all valid layout values", () => {
    for (const layout of ["grid", "flex", "custom"] as const) {
      expect(validateDashboardConfig({ layout, widgets: [] })).toBe(true);
    }
  });

  it("accepts optional theme and refreshInterval fields", () => {
    const config = { layout: "flex", widgets: [], theme: "dark", refreshInterval: 30 };
    expect(validateDashboardConfig(config)).toBe(true);
  });

  it("rejects null / undefined", () => {
    expect(validateDashboardConfig(null)).toBe(false);
    expect(validateDashboardConfig(undefined)).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(validateDashboardConfig("string")).toBe(false);
    expect(validateDashboardConfig(42)).toBe(false);
    expect(validateDashboardConfig([])).toBe(false);
  });

  it("rejects config with missing layout", () => {
    expect(validateDashboardConfig({ widgets: [] })).toBe(false);
  });

  it("rejects config with invalid layout value", () => {
    expect(validateDashboardConfig({ layout: "sidebar", widgets: [] })).toBe(false);
    expect(validateDashboardConfig({ layout: "", widgets: [] })).toBe(false);
    expect(validateDashboardConfig({ layout: 123, widgets: [] })).toBe(false);
  });

  it("rejects config with missing widgets array", () => {
    expect(validateDashboardConfig({ layout: "grid" })).toBe(false);
    expect(validateDashboardConfig({ layout: "grid", widgets: {} })).toBe(false);
  });

  it("rejects widget missing id", () => {
    const widget = { type: "chart", position: 0, size: "medium", visible: true };
    expect(validateDashboardConfig({ layout: "grid", widgets: [widget] })).toBe(false);
  });

  it("rejects widget with non-string id", () => {
    const widget = { id: 42, type: "chart", position: 0, size: "medium", visible: true };
    expect(validateDashboardConfig({ layout: "grid", widgets: [widget] })).toBe(false);
  });

  it("rejects widget missing type", () => {
    const widget = { id: "w1", position: 0, size: "medium", visible: true };
    expect(validateDashboardConfig({ layout: "grid", widgets: [widget] })).toBe(false);
  });

  it("rejects widget with invalid size", () => {
    const widget = { id: "w1", type: "chart", position: 0, size: "huge", visible: true };
    expect(validateDashboardConfig({ layout: "grid", widgets: [widget] })).toBe(false);
  });

  it("rejects widget with negative position", () => {
    const widget = { id: "w1", type: "chart", position: -1, size: "medium", visible: true };
    expect(validateDashboardConfig({ layout: "grid", widgets: [widget] })).toBe(false);
  });

  it("rejects widget with non-boolean visible", () => {
    const widget = { id: "w1", type: "chart", position: 0, size: "medium", visible: "yes" };
    expect(validateDashboardConfig({ layout: "grid", widgets: [widget] })).toBe(false);
  });

  it("rejects theme that is not a string", () => {
    const config = { layout: "grid", widgets: [], theme: 123 };
    expect(validateDashboardConfig(config)).toBe(false);
  });

  it("rejects refreshInterval that is not a number", () => {
    const config = { layout: "grid", widgets: [], refreshInterval: "fast" };
    expect(validateDashboardConfig(config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reorderWidgets
// ---------------------------------------------------------------------------

describe("reorderWidgets", () => {
  const threeWidgets = (): DashboardConfig =>
    makeConfig([
      makeWidget({ id: "a", position: 0 }),
      makeWidget({ id: "b", position: 1 }),
      makeWidget({ id: "c", position: 2 }),
    ]);

  it("moves widget from index 0 to index 2", () => {
    const result = reorderWidgets(threeWidgets(), 0, 2);
    expect(result.widgets.map((w) => w.id)).toEqual(["b", "c", "a"]);
  });

  it("normalizes positions after reorder", () => {
    const result = reorderWidgets(threeWidgets(), 0, 2);
    expect(result.widgets.map((w) => w.position)).toEqual([0, 1, 2]);
  });

  it("moves widget from index 2 to index 0", () => {
    const result = reorderWidgets(threeWidgets(), 2, 0);
    expect(result.widgets.map((w) => w.id)).toEqual(["c", "a", "b"]);
    expect(result.widgets.map((w) => w.position)).toEqual([0, 1, 2]);
  });

  it("is a no-op when fromIndex === toIndex", () => {
    const config = threeWidgets();
    const result = reorderWidgets(config, 1, 1);
    expect(result).toBe(config); // same reference — no new object
  });

  it("moves widget one step forward", () => {
    const result = reorderWidgets(threeWidgets(), 0, 1);
    expect(result.widgets.map((w) => w.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the original config", () => {
    const original = threeWidgets();
    reorderWidgets(original, 0, 2);
    expect(original.widgets.map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves other config properties", () => {
    const config = { ...threeWidgets(), theme: "dark" };
    const result = reorderWidgets(config, 0, 2);
    expect(result.theme).toBe("dark");
    expect(result.layout).toBe("grid");
  });
});

// ---------------------------------------------------------------------------
// toggleWidgetVisibility
// ---------------------------------------------------------------------------

describe("toggleWidgetVisibility", () => {
  it("toggles visible from true to false", () => {
    const config = makeConfig([makeWidget({ id: "w1", visible: true })]);
    const result = toggleWidgetVisibility(config, "w1");
    expect(result.widgets[0].visible).toBe(false);
  });

  it("toggles visible from false to true", () => {
    const config = makeConfig([makeWidget({ id: "w1", visible: false })]);
    const result = toggleWidgetVisibility(config, "w1");
    expect(result.widgets[0].visible).toBe(true);
  });

  it("only toggles the targeted widget", () => {
    const config = makeConfig([
      makeWidget({ id: "w1", visible: true }),
      makeWidget({ id: "w2", visible: true }),
    ]);
    const result = toggleWidgetVisibility(config, "w1");
    expect(result.widgets[0].visible).toBe(false);
    expect(result.widgets[1].visible).toBe(true); // unchanged
  });

  it("does nothing when widgetId does not exist", () => {
    const config = makeConfig([makeWidget({ id: "w1", visible: true })]);
    const result = toggleWidgetVisibility(config, "nonexistent");
    expect(result.widgets[0].visible).toBe(true);
  });

  it("does not mutate the original config", () => {
    const config = makeConfig([makeWidget({ id: "w1", visible: true })]);
    toggleWidgetVisibility(config, "w1");
    expect(config.widgets[0].visible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setWidgetRefreshRate
// ---------------------------------------------------------------------------

describe("setWidgetRefreshRate", () => {
  it("sets refresh rate correctly for a valid value", () => {
    const config = makeConfig([makeWidget({ id: "w1" })]);
    const result = setWidgetRefreshRate(config, "w1", 30);
    expect((result.widgets[0] as DashboardWidget & { refreshRate?: number }).refreshRate).toBe(30);
  });

  it("enforces minimum 5 seconds (input: 3)", () => {
    const config = makeConfig([makeWidget({ id: "w1" })]);
    const result = setWidgetRefreshRate(config, "w1", 3);
    expect((result.widgets[0] as DashboardWidget & { refreshRate?: number }).refreshRate).toBe(5);
  });

  it("enforces minimum 5 seconds (input: 1)", () => {
    const config = makeConfig([makeWidget({ id: "w1" })]);
    const result = setWidgetRefreshRate(config, "w1", 1);
    expect((result.widgets[0] as DashboardWidget & { refreshRate?: number }).refreshRate).toBe(5);
  });

  it("allows 0 (no refresh)", () => {
    const config = makeConfig([makeWidget({ id: "w1" })]);
    const result = setWidgetRefreshRate(config, "w1", 0);
    expect((result.widgets[0] as DashboardWidget & { refreshRate?: number }).refreshRate).toBe(0);
  });

  it("floors fractional seconds", () => {
    const config = makeConfig([makeWidget({ id: "w1" })]);
    const result = setWidgetRefreshRate(config, "w1", 7.9);
    expect((result.widgets[0] as DashboardWidget & { refreshRate?: number }).refreshRate).toBe(7);
  });

  it("accepts exactly 5 seconds (minimum boundary)", () => {
    const config = makeConfig([makeWidget({ id: "w1" })]);
    const result = setWidgetRefreshRate(config, "w1", 5);
    expect((result.widgets[0] as DashboardWidget & { refreshRate?: number }).refreshRate).toBe(5);
  });

  it("only updates the targeted widget", () => {
    const config = makeConfig([
      makeWidget({ id: "w1" }),
      makeWidget({ id: "w2" }),
    ]);
    const result = setWidgetRefreshRate(config, "w1", 60);
    expect((result.widgets[0] as DashboardWidget & { refreshRate?: number }).refreshRate).toBe(60);
    expect((result.widgets[1] as DashboardWidget & { refreshRate?: number }).refreshRate).toBeUndefined();
  });

  it("does not mutate the original config", () => {
    const config = makeConfig([makeWidget({ id: "w1" })]);
    setWidgetRefreshRate(config, "w1", 30);
    expect((config.widgets[0] as DashboardWidget & { refreshRate?: number }).refreshRate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// addWidget
// ---------------------------------------------------------------------------

describe("addWidget", () => {
  it("adds a widget at the end with the correct position", () => {
    const config = makeConfig([makeWidget({ id: "w1", position: 0 })]);
    const result = addWidget(config, { id: "w2", type: "table", size: "large", visible: true });
    expect(result.widgets).toHaveLength(2);
    expect(result.widgets[1].id).toBe("w2");
    expect(result.widgets[1].position).toBe(1);
  });

  it("adds a widget to an empty config with position 0", () => {
    const config = makeConfig([]);
    const result = addWidget(config, { id: "w1", type: "stat", size: "small", visible: true });
    expect(result.widgets).toHaveLength(1);
    expect(result.widgets[0].position).toBe(0);
  });

  it("preserves existing widgets when adding", () => {
    const config = makeConfig([makeWidget({ id: "w1", position: 0 })]);
    const result = addWidget(config, { id: "w2", type: "chart", size: "medium", visible: false });
    expect(result.widgets[0].id).toBe("w1");
  });

  it("does not mutate the original config", () => {
    const config = makeConfig([]);
    addWidget(config, { id: "w1", type: "stat", size: "small", visible: true });
    expect(config.widgets).toHaveLength(0);
  });

  it("preserves extra widget properties", () => {
    const config = makeConfig([]);
    const result = addWidget(config, {
      id: "w1",
      type: "stat",
      size: "small",
      visible: true,
      title: "Revenue",
    } as Omit<DashboardWidget, "position"> & { title: string });
    expect((result.widgets[0] as DashboardWidget & { title?: string }).title).toBe("Revenue");
  });
});

// ---------------------------------------------------------------------------
// removeWidget
// ---------------------------------------------------------------------------

describe("removeWidget", () => {
  it("removes a widget by id", () => {
    const config = makeConfig([
      makeWidget({ id: "w1", position: 0 }),
      makeWidget({ id: "w2", position: 1 }),
      makeWidget({ id: "w3", position: 2 }),
    ]);
    const result = removeWidget(config, "w2");
    expect(result.widgets.map((w) => w.id)).toEqual(["w1", "w3"]);
  });

  it("re-normalizes positions after removal", () => {
    const config = makeConfig([
      makeWidget({ id: "w1", position: 0 }),
      makeWidget({ id: "w2", position: 1 }),
      makeWidget({ id: "w3", position: 2 }),
    ]);
    const result = removeWidget(config, "w2");
    expect(result.widgets.map((w) => w.position)).toEqual([0, 1]);
  });

  it("removes first widget and renumbers", () => {
    const config = makeConfig([
      makeWidget({ id: "w1", position: 0 }),
      makeWidget({ id: "w2", position: 1 }),
    ]);
    const result = removeWidget(config, "w1");
    expect(result.widgets[0].id).toBe("w2");
    expect(result.widgets[0].position).toBe(0);
  });

  it("returns empty widgets array when last widget is removed", () => {
    const config = makeConfig([makeWidget({ id: "w1", position: 0 })]);
    const result = removeWidget(config, "w1");
    expect(result.widgets).toHaveLength(0);
  });

  it("does nothing when widgetId is not found", () => {
    const config = makeConfig([makeWidget({ id: "w1", position: 0 })]);
    const result = removeWidget(config, "nonexistent");
    expect(result.widgets).toHaveLength(1);
  });

  it("does not mutate the original config", () => {
    const config = makeConfig([
      makeWidget({ id: "w1", position: 0 }),
      makeWidget({ id: "w2", position: 1 }),
    ]);
    removeWidget(config, "w1");
    expect(config.widgets).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// updateWidget
// ---------------------------------------------------------------------------

describe("updateWidget", () => {
  it("merges a partial update into the target widget", () => {
    const config = makeConfig([makeWidget({ id: "w1", size: "small" })]);
    const result = updateWidget(config, "w1", { size: "large" });
    expect(result.widgets[0].size).toBe("large");
  });

  it("preserves existing properties not in the update", () => {
    const config = makeConfig([makeWidget({ id: "w1", type: "chart", visible: true })]);
    const result = updateWidget(config, "w1", { size: "large" });
    expect(result.widgets[0].type).toBe("chart");
    expect(result.widgets[0].visible).toBe(true);
  });

  it("cannot override the widget id via updates", () => {
    const config = makeConfig([makeWidget({ id: "w1" })]);
    const result = updateWidget(config, "w1", { id: "hacked" } as Partial<DashboardWidget>);
    expect(result.widgets[0].id).toBe("w1");
  });

  it("only updates the targeted widget", () => {
    const config = makeConfig([
      makeWidget({ id: "w1", size: "small" }),
      makeWidget({ id: "w2", size: "small" }),
    ]);
    const result = updateWidget(config, "w1", { size: "large" });
    expect(result.widgets[1].size).toBe("small");
  });

  it("does nothing when widgetId is not found", () => {
    const config = makeConfig([makeWidget({ id: "w1", size: "small" })]);
    const result = updateWidget(config, "nonexistent", { size: "large" });
    expect(result.widgets[0].size).toBe("small");
  });

  it("does not mutate the original config", () => {
    const config = makeConfig([makeWidget({ id: "w1", size: "small" })]);
    updateWidget(config, "w1", { size: "large" });
    expect(config.widgets[0].size).toBe("small");
  });
});

// ---------------------------------------------------------------------------
// createDefaultDashboardConfig
// ---------------------------------------------------------------------------

describe("createDefaultDashboardConfig", () => {
  it("returns a config that passes validateDashboardConfig", () => {
    const config = createDefaultDashboardConfig();
    expect(validateDashboardConfig(config)).toBe(true);
  });

  it("returns grid layout", () => {
    const config = createDefaultDashboardConfig();
    expect(config.layout).toBe("grid");
  });

  it("returns empty widgets array", () => {
    const config = createDefaultDashboardConfig();
    expect(config.widgets).toEqual([]);
  });

  it("returns a new object on each call (no shared reference)", () => {
    const a = createDefaultDashboardConfig();
    const b = createDefaultDashboardConfig();
    a.widgets.push(makeWidget());
    expect(b.widgets).toHaveLength(0);
  });
});
