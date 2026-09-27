import { Request, Response } from "express";
import {
  activityTrackingService,
  ActivityGranularity,
} from "../services/activityTrackingService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

/**
 * Analytics dashboard handlers (admin).
 *
 * These endpoints aggregate the `user_events` activity stream into product
 * decisions: headline usage, trends, behavioral cohorts and DAU series.
 */

function parseDays(value: unknown, fallback = 30): number {
  if (typeof value !== "string" || !value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 3650);
}

function parseGranularity(value: unknown): ActivityGranularity {
  if (value === "week" || value === "month") return value;
  return "day";
}

function parseCohortPeriod(value: unknown): "week" | "month" {
  if (value === "month") return "month";
  return "week";
}

export const analyticsOverviewHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const days = parseDays(req.query.days);
    const overview = await activityTrackingService.getOverview(days);
    return res.json(overview);
  } catch (error) {
    console.error("Analytics overview failed:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to load analytics", {
      error: "Failed to load analytics overview",
    });
  }
};

export const analyticsTrendsHandler = async (req: Request, res: Response) => {
  try {
    const days = parseDays(req.query.days);
    const granularity = parseGranularity(req.query.granularity);
    const trend = await activityTrackingService.getUsageTrend(
      days,
      granularity,
    );
    return res.json({ days, granularity, data: trend });
  } catch (error) {
    console.error("Analytics trends failed:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to load trends", {
      error: "Failed to load usage trends",
    });
  }
};

export const analyticsActiveUsersHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const days = parseDays(req.query.days);
    const series = await activityTrackingService.getDailyActiveUsers(days);
    return res.json({ days, data: series });
  } catch (error) {
    console.error("Analytics active users failed:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to load active users",
      {
        error: "Failed to load active user series",
      },
    );
  }
};

export const analyticsCohortsHandler = async (req: Request, res: Response) => {
  try {
    const cohortPeriod = parseCohortPeriod(req.query.cohortPeriod);
    const report = await activityTrackingService.getCohortRetention(
      cohortPeriod,
    );
    return res.json(report);
  } catch (error) {
    console.error("Analytics cohorts failed:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to load cohort retention",
      {
        error: "Failed to load cohort retention",
      },
    );
  }
};
