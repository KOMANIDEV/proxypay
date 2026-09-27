/**
 * Admin Deprecation Routes — Issue #393
 *
 * Exposes the deprecation timeline and usage monitoring so operators can see
 * which API endpoints are deprecated, when they sunset, and how much traffic
 * they are still receiving. This drives the "migrate before sunset" workflow.
 */

import { Router, Request, Response } from "express";
import { DeprecationRegistry } from "../../middleware/deprecation";
import { getDeprecationTimeline as getApiVersionTimeline } from "../../middleware/apiVersion";
import { getDeprecationTimeline as getOpenApiTimeline } from "../../openapi/deprecationHandler";
import { createError } from "../../middleware/errorHandler";
import { ERROR_CODES } from "../../constants/errorCodes";

export const adminDeprecationRoutes = Router();

/**
 * GET /api/admin/deprecations
 * Returns the full deprecation timeline for endpoints and API versions.
 */
adminDeprecationRoutes.get("/", (req: Request, res: Response) => {
  try {
    res.json({
      endpoints: DeprecationRegistry.getTimeline(),
      apiVersions: getApiVersionTimeline(),
      openApiAnnotations: getOpenApiTimeline(),
    });
  } catch (err) {
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to retrieve deprecation timeline",
      {
        message: err instanceof Error ? err.message : "Unknown error",
      },
    );
  }
});

/**
 * GET /api/admin/deprecations/usage
 * Returns current traffic counts for every deprecated endpoint, so operators
 * can monitor who has not yet migrated.
 */
adminDeprecationRoutes.get("/usage", async (req: Request, res: Response) => {
  try {
    const usage = await DeprecationRegistry.getUsageStats();
    res.json({
      usage,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to retrieve deprecation usage",
      {
        message: err instanceof Error ? err.message : "Unknown error",
      },
    );
  }
});

/**
 * GET /api/admin/deprecations/migration-guide
 * Returns the canonical migration documentation that these deprecations point
 * at, so tooling can link straight from a deprecation warning to guidance.
 */
adminDeprecationRoutes.get("/migration-guide", (req: Request, res: Response) => {
  res.json({
    guides: [
      {
        title: "API Migration Guide: v1 → v2",
        path: "/docs/API_V1_TO_V2_MIGRATION.md",
        url: "https://docs.example.com/api/v1-to-v2-migration",
      },
      {
        title: "API Versioning",
        path: "/docs/API_VERSIONING.md",
        url: "https://docs.example.com/api/versioning",
      },
    ],
  });
});
