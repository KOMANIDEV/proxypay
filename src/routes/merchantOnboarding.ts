/**
 * Merchant Onboarding Progress Routes
 *
 * REST endpoints for querying and advancing merchant onboarding status.
 *
 * Follows the same pattern as src/routes/merchants.ts:
 *   - Express Router
 *   - authenticateToken + checkAccountStatusStrict middleware
 *   - Zod-validated request bodies
 *   - Consistent JSON response shape
 *
 * Issue #410 — Merchant Onboarding Progress Tracking
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  MerchantOnboardingService,
  type OnboardingStep,
} from "../services/merchantOnboarding";
import { authenticateToken } from "../middleware/auth";
import { checkAccountStatusStrict } from "../middleware/checkAccountStatus";

const router = Router();
const onboardingService = new MerchantOnboardingService();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const VALID_STEPS: OnboardingStep[] = [
  "profile_complete",
  "email_verified",
  "invitation_accepted",
  "kyc_started",
  "kyc_verified",
  "bank_account_linked",
  "first_transaction",
];

const CompleteStepSchema = z.object({
  step: z.enum(VALID_STEPS as [OnboardingStep, ...OnboardingStep[]]),
  metadata: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendError(
  res: Response,
  status: number,
  message: string,
  code?: string,
): void {
  res.status(status).json({
    success: false,
    error: { message, ...(code ? { code } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Static routes — MUST be defined before dynamic /:merchantId routes to
// prevent Express from treating static path segments as param values.
// ---------------------------------------------------------------------------

/**
 * GET /api/merchants/onboarding/analytics
 * Returns aggregate onboarding analytics (admin use).
 */
router.get(
  "/onboarding/analytics",
  authenticateToken,
  checkAccountStatusStrict,
  async (_req: Request, res: Response, _next: NextFunction): Promise<void> => {
    try {
      const analytics = await onboardingService.getAnalytics();
      res.status(200).json({ success: true, data: analytics });
    } catch (error) {
      console.error("[merchant-onboarding] getAnalytics error:", error);
      sendError(res, 500, "Failed to retrieve onboarding analytics");
    }
  },
);

// ---------------------------------------------------------------------------
// Dynamic routes — per-merchant endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/merchants/:merchantId/onboarding
 * Returns the onboarding progress for the specified merchant.
 */
router.get(
  "/:merchantId/onboarding",
  authenticateToken,
  checkAccountStatusStrict,
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const { merchantId } = req.params;

    try {
      const progress = await onboardingService.getProgress(merchantId);
      res.status(200).json({ success: true, data: progress });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Internal server error";
      if (message.includes("not found")) {
        sendError(res, 404, message, "MERCHANT_NOT_FOUND");
        return;
      }
      console.error("[merchant-onboarding] getProgress error:", error);
      sendError(res, 500, "Failed to retrieve onboarding progress");
    }
  },
);

/**
 * POST /api/merchants/:merchantId/onboarding/complete-step
 * Mark a specific onboarding step as completed.
 *
 * Body:
 *   { step: OnboardingStep, metadata?: Record<string, unknown> }
 */
router.post(
  "/:merchantId/onboarding/complete-step",
  authenticateToken,
  checkAccountStatusStrict,
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const { merchantId } = req.params;

    const parseResult = CompleteStepSchema.safeParse(req.body);
    if (!parseResult.success) {
      sendError(
        res,
        422,
        parseResult.error.errors.map((e) => e.message).join("; "),
        "VALIDATION_ERROR",
      );
      return;
    }

    const { step, metadata } = parseResult.data;

    try {
      const progress = await onboardingService.completeStep(
        merchantId,
        step,
        metadata ?? {},
      );
      res.status(200).json({ success: true, data: progress });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Internal server error";
      if (message.includes("not found")) {
        sendError(res, 404, message, "MERCHANT_NOT_FOUND");
        return;
      }
      console.error("[merchant-onboarding] completeStep error:", error);
      sendError(res, 500, "Failed to complete onboarding step");
    }
  },
);

export default router;
