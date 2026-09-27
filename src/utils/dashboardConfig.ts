/**
 * Dashboard Configuration Types and Validator
 * Provides reusable types and validation for admin dashboard personalization
 */

export interface DashboardWidget {
  id: string;
  type: string;
  position: number;
  size: "small" | "medium" | "large";
  visible: boolean;
  [key: string]: unknown;
}

export interface DashboardConfig {
  layout: "grid" | "flex" | "custom";
  widgets: DashboardWidget[];
  theme?: string;
  refreshInterval?: number;
  [key: string]: unknown;
}

/**
 * Validates a dashboard configuration object against the schema
 * @param config - The configuration object to validate
 * @returns true if config matches DashboardConfig schema, false otherwise
 */
export const validateDashboardConfig = (
  config: unknown,
): config is DashboardConfig => {
  if (!config || typeof config !== "object") {
    return false;
  }

  const cfg = config as Record<string, unknown>;

  // Validate required fields
  if (!cfg.layout || typeof cfg.layout !== "string") {
    return false;
  }

  if (!["grid", "flex", "custom"].includes(cfg.layout as string)) {
    return false;
  }

  if (!Array.isArray(cfg.widgets)) {
    return false;
  }

  // Validate widgets array
  for (const widget of cfg.widgets) {
    if (typeof widget !== "object" || !widget) {
      return false;
    }

    const w = widget as Record<string, unknown>;

    if (!w.id || typeof w.id !== "string") {
      return false;
    }

    if (!w.type || typeof w.type !== "string") {
      return false;
    }

    if (typeof w.position !== "number" || w.position < 0) {
      return false;
    }

    if (!["small", "medium", "large"].includes(w.size as string)) {
      return false;
    }

    if (typeof w.visible !== "boolean") {
      return false;
    }
  }

  // Optional fields validation
  if (cfg.theme && typeof cfg.theme !== "string") {
    return false;
  }

  if (cfg.refreshInterval && typeof cfg.refreshInterval !== "number") {
    return false;
  }

  return true;
};

/**
 * Creates a default dashboard configuration
 * @returns Default DashboardConfig
 */
export const createDefaultDashboardConfig = (): DashboardConfig => {
  return {
    layout: "grid",
    widgets: [],
  };
};

/**
 * Validation error messages for dashboard config
 */
export const DASHBOARD_CONFIG_VALIDATION_ERRORS = [
  "Config must have a valid layout (grid, flex, custom)",
  "Config must have a widgets array with valid widget objects",
  "Each widget must have: id (string), type (string), position (number), size (small/medium/large), visible (boolean)",
  "Optional fields: theme (string), refreshInterval (number)",
];

/**
 * Reorder widgets in a dashboard configuration (supports drag-and-drop).
 * Moves the widget at fromIndex to toIndex and updates all positions.
 */
export const reorderWidgets = (
  config: DashboardConfig,
  fromIndex: number,
  toIndex: number,
): DashboardConfig => {
  if (fromIndex === toIndex) return config;
  const widgets = [...config.widgets];
  const [moved] = widgets.splice(fromIndex, 1);
  widgets.splice(toIndex, 0, moved);
  // Normalize positions sequentially
  const updated = widgets.map((w, i) => ({ ...w, position: i }));
  return { ...config, widgets: updated };
};

/**
 * Toggle a widget's visibility.
 */
export const toggleWidgetVisibility = (
  config: DashboardConfig,
  widgetId: string,
): DashboardConfig => {
  const widgets = config.widgets.map((w) =>
    w.id === widgetId ? { ...w, visible: !w.visible } : w,
  );
  return { ...config, widgets };
};

/**
 * Set a specific refresh rate for a widget (seconds, minimum 5s).
 * @param refreshRateSecs - refresh rate in seconds (min 5, 0 = no refresh)
 */
export const setWidgetRefreshRate = (
  config: DashboardConfig,
  widgetId: string,
  refreshRateSecs: number,
): DashboardConfig => {
  const normalizedRate = refreshRateSecs === 0 ? 0 : Math.max(5, Math.floor(refreshRateSecs));
  const widgets = config.widgets.map((w) =>
    w.id === widgetId ? { ...w, refreshRate: normalizedRate } : w,
  );
  return { ...config, widgets };
};

/**
 * Merge a partial widget update into the config.
 */
export const updateWidget = (
  config: DashboardConfig,
  widgetId: string,
  updates: Partial<DashboardWidget>,
): DashboardConfig => {
  const widgets = config.widgets.map((w) =>
    w.id === widgetId ? { ...w, ...updates, id: w.id } : w,
  );
  return { ...config, widgets };
};

/**
 * Add a widget to the configuration.
 */
export const addWidget = (
  config: DashboardConfig,
  widget: Omit<DashboardWidget, 'position'>,
): DashboardConfig => {
  const position = config.widgets.length;
  return {
    ...config,
    widgets: [...config.widgets, { ...widget, position }],
  };
};

/**
 * Remove a widget from the config and re-normalize positions.
 */
export const removeWidget = (
  config: DashboardConfig,
  widgetId: string,
): DashboardConfig => {
  const filtered = config.widgets
    .filter((w) => w.id !== widgetId)
    .map((w, i) => ({ ...w, position: i }));
  return { ...config, widgets: filtered };
};