import { WebSocketManager } from "./websocketManager";
import { pool } from "../config/database";

// ---------------------------------------------------------------------------
// Real-Time Dashboard Widgets (#461)
// ---------------------------------------------------------------------------

export interface DashboardWidgetConfig {
  widgetId: string;
  type: "metric" | "chart" | "table" | "alert";
  refreshIntervalMs: number;
  query: string;
  label: string;
}

export interface WidgetUpdate {
  widgetId: string;
  type: string;
  label: string;
  data: unknown;
  timestamp: string;
}

/**
 * Pre-defined dashboard widgets with SQL queries.
 */
const DASHBOARD_WIDGETS: DashboardWidgetConfig[] = [
  {
    widgetId: "transaction_volume",
    type: "metric",
    refreshIntervalMs: 10_000,
    query: `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS last_hour,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h
      FROM transactions
    `,
    label: "Transaction Volume",
  },
  {
    widgetId: "provider_status",
    type: "table",
    refreshIntervalMs: 30_000,
    query: `
      SELECT provider, status, last_checked_at, response_time_ms
      FROM provider_health
      ORDER BY last_checked_at DESC
      LIMIT 20
    `,
    label: "Provider Health Status",
  },
  {
    widgetId: "revenue_chart",
    type: "chart",
    refreshIntervalMs: 60_000,
    query: `
      SELECT
        DATE_TRUNC('hour', created_at) AS hour,
        SUM(amount) AS total_amount,
        COUNT(*) AS tx_count
      FROM transactions
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY DATE_TRUNC('hour', created_at)
      ORDER BY hour DESC
    `,
    label: "Revenue (24h)",
  },
  {
    widgetId: "active_users",
    type: "metric",
    refreshIntervalMs: 15_000,
    query: `
      SELECT
        COUNT(DISTINCT user_id) AS active_users
      FROM transactions
      WHERE created_at > NOW() - INTERVAL '15 minutes'
    `,
    label: "Active Users",
  },
  {
    widgetId: "recent_alerts",
    type: "alert",
    refreshIntervalMs: 5_000,
    query: `
      SELECT id, severity, message, created_at
      FROM audit_logs
      WHERE severity IN ('high', 'critical')
        AND created_at > NOW() - INTERVAL '1 hour'
      ORDER BY created_at DESC
      LIMIT 10
    `,
    label: "Recent Alerts",
  },
  {
    widgetId: "fraud_summary",
    type: "metric",
    refreshIntervalMs: 20_000,
    query: `
      SELECT
        COUNT(*) AS flagged_count,
        COUNT(*) FILTER (WHERE blocked = true) AS blocked_count
      FROM fraud_alerts
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `,
    label: "Fraud Summary (24h)",
  },
];

/**
 * Fetch widget data from the database.
 */
async function fetchWidgetData(
  widget: DashboardWidgetConfig,
): Promise<unknown> {
  try {
    const result = await pool.query(widget.query);
    if (widget.type === "metric" && result.rows.length > 0) {
      return result.rows[0];
    }
    return result.rows;
  } catch (error) {
    console.error(`[dashboard] Widget ${widget.widgetId} query failed:`, error);
    return { error: "Failed to fetch data" };
  }
}

/**
 * Start broadcasting dashboard widget updates to all authenticated clients.
 * Call this after WebSocketManager is initialized.
 */
export function startDashboardBroadcast(
  wsManager: WebSocketManager,
): Map<string, ReturnType<typeof setInterval>> {
  const intervals = new Map<string, ReturnType<typeof setInterval>>();

  for (const widget of DASHBOARD_WIDGETS) {
    const interval = setInterval(async () => {
      const data = await fetchWidgetData(widget);
      const update: WidgetUpdate = {
        widgetId: widget.widgetId,
        type: widget.type,
        label: widget.label,
        data,
        timestamp: new Date().toISOString(),
      };

      wsManager.broadcast({
        type: "dashboard_widget",
        data: update,
      });
    }, widget.refreshIntervalMs);

    intervals.set(widget.widgetId, interval);
  }

  console.info(
    `[dashboard] Started ${DASHBOARD_WIDGETS.length} widget broadcast intervals`,
  );
  return intervals;
}

/**
 * Stop all dashboard broadcast intervals.
 */
export function stopDashboardBroadcast(
  intervals: Map<string, ReturnType<typeof setInterval>>,
): void {
  for (const [widgetId, interval] of intervals) {
    clearInterval(interval);
    console.info(`[dashboard] Stopped widget: ${widgetId}`);
  }
  intervals.clear();
}

/**
 * Get the list of available dashboard widgets (for client discovery).
 */
export function getDashboardWidgetConfigs(): Omit<DashboardWidgetConfig, "query">[] {
  return DASHBOARD_WIDGETS.map(({ query: _q, ...rest }) => rest);
}
