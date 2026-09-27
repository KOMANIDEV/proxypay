/**
 * #405 – Provider Health Dashboard Routes
 *
 * GET /api/admin/providers/health            – real-time dashboard (all providers)
 * GET /api/admin/providers/:provider/health  – single provider detail
 * GET /api/admin/providers/:provider/trends  – historical trend data (?period=24h|7d)
 * POST /api/admin/providers/health/refresh   – force-refresh cached dashboard
 */

import { Router, Request, Response } from "express";
import {
  getProviderHealthDashboard,
  getProviderHistoricalTrends,
  type ProviderName,
} from "../services/providerHealthDashboardService";

const router = Router();

const VALID_PROVIDERS: ProviderName[] = ["mtn", "airtel", "orange"];

// ─── GET / (all providers real-time dashboard) ────────────────────────────────

router.get("/", async (_req: Request, res: Response) => {
  try {
    const dashboard = await getProviderHealthDashboard();
    res.json(dashboard);
  } catch (err) {
    console.error("[provider-health] dashboard fetch failed", err);
    res.status(500).json({ error: "Failed to fetch provider health dashboard" });
  }
});

// ─── POST /refresh (force cache refresh) ──────────────────────────────────────

router.post("/refresh", async (_req: Request, res: Response) => {
  try {
    const dashboard = await getProviderHealthDashboard(true /* forceRefresh */);
    res.json({ ...dashboard, refreshed: true });
  } catch (err) {
    console.error("[provider-health] refresh failed", err);
    res.status(500).json({ error: "Failed to refresh provider health dashboard" });
  }
});

// ─── GET /:provider (single provider real-time detail) ────────────────────────

router.get("/:provider", async (req: Request, res: Response) => {
  const provider = req.params.provider as ProviderName;

  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({
      error: `Invalid provider. Valid values: ${VALID_PROVIDERS.join(", ")}`,
    });
  }

  try {
    const dashboard = await getProviderHealthDashboard();
    const providerData = dashboard.providers.find((p) => p.provider === provider);

    if (!providerData) {
      return res.status(404).json({ error: `No data for provider: ${provider}` });
    }

    res.json({ data: providerData, generatedAt: dashboard.generatedAt });
  } catch (err) {
    console.error("[provider-health] provider fetch failed", { provider, err });
    res.status(500).json({ error: "Failed to fetch provider health data" });
  }
});

// ─── GET /:provider/trends (historical) ───────────────────────────────────────

router.get("/:provider/trends", async (req: Request, res: Response) => {
  const provider = req.params.provider as ProviderName;

  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({
      error: `Invalid provider. Valid values: ${VALID_PROVIDERS.join(", ")}`,
    });
  }

  const period = req.query.period === "7d" ? "7d" : "24h";

  try {
    const trends = await getProviderHistoricalTrends(provider, period);
    res.json(trends);
  } catch (err) {
    console.error("[provider-health] trends fetch failed", { provider, period, err });
    res.status(500).json({ error: "Failed to fetch provider health trends" });
  }
});

export default router;
