/**
 * Settings Panel — REST API
 *
 * Endpoints:
 *   GET    /api/settings          — Retrieve current user's settings
 *   PATCH  /api/settings          — Partial update (theme, currency, notifications)
 *   DELETE /api/settings          — Reset to defaults
 *   GET    /api/settings/options  — Enumerate valid option values for the UI
 *
 * Authentication: all routes require a valid JWT (requireAuth middleware).
 * The userId is read from req.user.id (populated by the auth middleware).
 *
 * Accessibility / WCAG AA:
 *   - Validation errors are returned as structured JSON arrays so assistive
 *     technologies can surface them field-by-field.
 *   - The "system" theme value signals the client to honour
 *     prefers-color-scheme, ensuring WCAG AA contrast compliance without
 *     hard-coding a colour scheme.
 *   - The "compact" toastDensity maps to prefers-reduced-motion on the client,
 *     reducing animation for users who need it.
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  getSettings,
  updateSettings,
  resetSettings,
  SETTINGS_OPTIONS,
  PartialUserSettings,
  onSettingsChanged,
} from "../utils/settingsPanel";
import { createPreferenceChangeHandler } from "../services/preferenceChangeService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// All settings routes require authentication.
router.use(requireAuth);

// Every settings mutation is appended to the preference change audit trail
// and enqueues a `preference.changed` webhook notification.
onSettingsChanged(createPreferenceChangeHandler());

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------
router.get("/", (req: Request, res: Response): void => {
  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
      error: "Unauthorized",
    });
  }

  const settings = getSettings(userId);
  res.json({ settings });
});

// ---------------------------------------------------------------------------
// PATCH /api/settings
// ---------------------------------------------------------------------------
router.patch("/", (req: Request, res: Response): void => {
  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
      error: "Unauthorized",
    });
  }

  const { expectedVersion, ...patchFields } =
    req.body as PartialUserSettings & {
      expectedVersion?: number;
    };
  const patch = patchFields as PartialUserSettings;
  const result = updateSettings(userId, patch, {
    expectedVersion:
      typeof expectedVersion === "number" ? expectedVersion : undefined,
    source: "api",
    actorId: userId,
  });

  if ("errors" in result) {
    throw createError(ERROR_CODES.UNPROCESSABLE_CONTENT, "Validation failed", {
      details: result.errors,
    });
  }

  if ("conflict" in result) {
    throw createError(
      ERROR_CODES.CONFLICT,
      "Settings were modified by another session",
      {
        current: result.current,
        expectedVersion: result.expectedVersion,
        message: `Re-fetch settings (now at version ${result.current.version}) and retry with the latest version`,
      },
    );
  }

  res.json({ settings: result.settings });
});

// ---------------------------------------------------------------------------
// DELETE /api/settings  (reset to defaults)
// ---------------------------------------------------------------------------
router.delete("/", (req: Request, res: Response): void => {
  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
      error: "Unauthorized",
    });
  }

  const settings = resetSettings(userId, { source: "api", actorId: userId });
  res.json({ settings });
});

// ---------------------------------------------------------------------------
// GET /api/settings/options
// ---------------------------------------------------------------------------
router.get("/options", (_req: Request, res: Response): void => {
  res.json({ options: SETTINGS_OPTIONS });
});

export default router;
