/**
 * #358 – /api/health/providers endpoint
 *
 * Express router that exposes provider health aggregation and system health.
 */

import { Router, Request, Response } from "express";
import {
  getSystemHealthAggregation,
} from "../services/providerHealthAggregationService";
import {
  getProviderHealthDashboard,
  getProviderHistoricalTrends,
  ProviderName,
} from "../services/providerHealthDashboardService";

const router = Router();

/**
 * GET /api/health/providers
 *
 * Returns aggregated system health and per-provider scores.
 */
router.get("/providers", async (_req: Request, res: Response) => {
  try {
    const forceRefresh = _req.query.force === "true";
    const aggregation = await getSystemHealthAggregation(forceRefresh);

    const statusCode = aggregation.overallStatus === "healthy"
      ? 200
      : aggregation.overallStatus === "degraded"
        ? 200
        : 503;

    res.status(statusCode).json(aggregation);
  } catch (err) {
    res.status(500).json({
      error: "Failed to retrieve provider health aggregation",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * GET /api/health/providers/dashboard
 *
 * Returns the raw per-provider real-time dashboard.
 */
router.get("/providers/dashboard", async (_req: Request, res: Response) => {
  try {
    const forceRefresh = _req.query.force === "true";
    const dashboard = await getProviderHealthDashboard(forceRefresh);
    res.json(dashboard);
  } catch (err) {
    res.status(500).json({
      error: "Failed to retrieve provider dashboard",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * GET /api/health/providers/:provider/trends
 *
 * Returns historical trend data for a specific provider.
 * Query params: period=24h|7d (default 24h)
 */
router.get("/providers/:provider/trends", async (req: Request, res: Response) => {
  try {
    const provider = req.params.provider as ProviderName;
    if (!["mtn", "airtel", "orange"].includes(provider)) {
      res.status(400).json({ error: "Invalid provider. Must be one of: mtn, airtel, orange" });
      return;
    }

    const period = (req.query.period as "24h" | "7d") || "24h";
    const trends = await getProviderHistoricalTrends(provider, period);
    res.json(trends);
  } catch (err) {
    res.status(500).json({
      error: "Failed to retrieve provider trends",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

export default router;
