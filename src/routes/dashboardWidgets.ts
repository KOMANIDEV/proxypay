import { Router, Request, Response } from "express";
import {
  getDashboardWidgetConfigs,
} from "../websocket/dashboardWidgets";

// ---------------------------------------------------------------------------
// Dashboard Widget Discovery Routes (#461)
// ---------------------------------------------------------------------------

export const dashboardWidgetRoutes = Router();

/**
 * GET /dashboard/widgets
 * Returns the list of available dashboard widgets and their configuration
 * (without the SQL query, for security).
 */
dashboardWidgetRoutes.get("/widgets", (_req: Request, res: Response) => {
  const widgets = getDashboardWidgetConfigs();
  res.json({
    widgets,
    websocket: {
      subscribe: "Send { type: 'subscribe_dashboard' } after auth",
      updateType: "dashboard_widget",
    },
  });
});
