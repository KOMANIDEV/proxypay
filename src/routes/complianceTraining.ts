/**
 * #481 – Compliance Training Dashboard
 *
 * Learner:
 *   GET  /api/compliance/training/modules            – available modules (answers stripped)
 *   GET  /api/compliance/training/modules/:id        – one module for learning
 *   POST /api/compliance/training/attempts           – submit an attempt
 *   GET  /api/compliance/training/me                 – own compliance status
 *
 * Compliance officer:
 *   GET  /api/compliance/training/dashboard          – org-wide dashboard
 *   GET  /api/compliance/training/certifications     – certificate register
 *   GET  /api/compliance/training/expiring           – expiring soon
 *   POST /api/compliance/training/assignments        – assign modules
 *   POST /api/compliance/training/modules            – create a module
 *   POST /api/compliance/training/certifications/:id/revoke
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateToken } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { queryRead } from "../config/database";
import {
  AssignModuleSchema,
  ComplianceTrainingError,
  CreateModuleSchema,
  SubmitAttemptSchema,
  assignTrainingModule,
  createTrainingModule,
  getComplianceTrainingSummary,
  getExpiringCertifications,
  getModuleForLearner,
  getUserComplianceStatus,
  listTrainingModules,
  revokeAssignment,
  revokeCertification,
  submitAttempt,
} from "../services/complianceTrainingService";

const router = Router();

router.use(authenticateToken);

/**
 * Compliance-officer gate. Uses the shared role hierarchy so "admin" and
 * "super_admin" both qualify, matching the rest of the admin surface.
 */
const requireComplianceOfficer = requireRole("admin");

/** Resolve the acting user id from whichever auth shape the request carries. */
function actingUserId(req: Request): string {
  const userId = req.jwtUser?.userId ?? (req.user as { id?: string } | undefined)?.id;
  if (!userId) {
    throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");
  }
  return userId;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get("/dashboard", requireComplianceOfficer, async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.expiringWithinDays) || 30, 365);
  const summary = await getComplianceTrainingSummary({
    expiringWithinDays: days,
  });
  res.json({ data: summary });
});

router.get("/expiring", requireComplianceOfficer, async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 30, 365);
  const certifications = await getExpiringCertifications(days);
  res.json({ data: certifications, meta: { withinDays: days } });
});

router.get("/certifications", requireComplianceOfficer, async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const status = req.query.status as string | undefined;

  // `status` is a whitelist of the derived states, not a column, so it is
  // matched against the same CASE expression the view uses.
  const statusFilter =
    status === "valid" || status === "expiring" || status === "expired" || status === "revoked"
      ? `
        AND (
          CASE
            WHEN revoked_at IS NOT NULL THEN 'revoked'
            WHEN expires_at IS NULL     THEN 'valid'
            WHEN expires_at < NOW()     THEN 'expired'
            WHEN expires_at < NOW() + INTERVAL '30 days' THEN 'expiring'
            ELSE 'valid'
          END
        ) = $2`
      : "";
  const params: unknown[] = [limit];
  if (statusFilter) params.push(status);

  const { rows } = await queryRead(
    `SELECT c.id, c.certificate_number, c.user_id, c.score, c.issued_at,
            c.expires_at, c.revoked_at, c.revoked_reason,
            m.code, m.title AS module_title
       FROM compliance_certifications c
       JOIN compliance_training_modules m ON m.id = c.module_id
      WHERE TRUE ${statusFilter}
      ORDER BY c.issued_at DESC
      LIMIT $1`,
    params,
  );

  res.json({ data: rows, meta: { limit } });
});

router.post(
  "/certifications/:id/revoke",
  requireComplianceOfficer,
  async (req: Request, res: Response) => {
    const parsed = z
      .object({ reason: z.string().min(1).max(500) })
      .safeParse(req.body);
    if (!parsed.success) {
      throw createError(ERROR_CODES.INVALID_INPUT, "A revocation reason is required");
    }
    const revoked = await revokeCertification(req.params.id, parsed.data.reason);
    if (!revoked) {
      throw createError(
        ERROR_CODES.NOT_FOUND,
        "Certificate not found or already revoked",
      );
    }
    res.json({ success: true });
  },
);

// ─── Modules ──────────────────────────────────────────────────────────────────

router.get("/modules", async (req: Request, res: Response) => {
  // The learner view: questions without correct answers.
  const modules = await listTrainingModules(false);
  res.json({
    data: modules.map((module) => ({
      id: module.id,
      code: module.code,
      title: module.title,
      description: module.description,
      questionCount: module.content.length,
      passingScore: module.passingScore,
      validityMonths: module.validityMonths,
    })),
  });
});

router.post("/modules", requireComplianceOfficer, async (req: Request, res: Response) => {
  const parsed = CreateModuleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid training module");
  }
  try {
    const module = await createTrainingModule(parsed.data);
    res.status(201).json({ data: module });
  } catch (error) {
    if (error instanceof ComplianceTrainingError) {
      throw createError(ERROR_CODES.INVALID_INPUT, error.message);
    }
    throw error;
  }
});

router.get("/modules/:id", async (req: Request, res: Response) => {
  const module = await getModuleForLearner(req.params.id);
  if (!module) {
    throw createError(ERROR_CODES.NOT_FOUND, "Training module not found");
  }
  res.json({ data: module });
});

// ─── Assignments ──────────────────────────────────────────────────────────────

router.post("/assignments", requireComplianceOfficer, async (req: Request, res: Response) => {
  const parsed = AssignModuleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid assignment");
  }
  try {
    const result = await assignTrainingModule(parsed.data, actingUserId(req));
    res.status(201).json({ data: result });
  } catch (error) {
    if (error instanceof ComplianceTrainingError) {
      throw createError(ERROR_CODES.INVALID_INPUT, error.message);
    }
    throw error;
  }
});

router.delete(
  "/assignments/:moduleId/:userId",
  requireComplianceOfficer,
  async (req: Request, res: Response) => {
    const revoked = await revokeAssignment(req.params.moduleId, req.params.userId);
    if (!revoked) {
      throw createError(ERROR_CODES.NOT_FOUND, "Assignment not found");
    }
    res.json({ success: true });
  },
);

// ─── Attempts ─────────────────────────────────────────────────────────────────

router.post("/attempts", async (req: Request, res: Response) => {
  const parsed = SubmitAttemptSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid attempt");
  }
  try {
    const result = await submitAttempt(actingUserId(req), parsed.data);
    res.json({ data: result });
  } catch (error) {
    if (error instanceof ComplianceTrainingError) {
      throw createError(ERROR_CODES.NOT_FOUND, error.message);
    }
    throw error;
  }
});

router.get("/me", async (req: Request, res: Response) => {
  const status = await getUserComplianceStatus(actingUserId(req));
  res.json({ data: status });
});

export default router;
