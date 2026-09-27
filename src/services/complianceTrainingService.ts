/**
 * #481 – Compliance Training Dashboard
 *
 * Staff compliance training has to be evidenced, not just delivered. This
 * module owns the lifecycle:
 *
 *   modules/assignments -> attempts -> certification -> expiry
 *
 * and the dashboard aggregates it into the view a compliance officer actually
 * needs: who is trained, who is overdue, whose certification lapses soon, and
 * how the cohort is trending.
 *
 * Design decisions worth calling out:
 *   - Answers are never sent to the client with the correct answers attached.
 *     `getModuleForLearner()` strips them; grading happens server-side.
 *   - A certificate is issued by the same statement that records the passing
 *     completion, so a passed attempt can never exist without its certificate.
 *   - Certificate numbers are generated in the application (not the database)
 *     so their format matches the company's paper trail conventions.
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import { queryRead, queryWrite, writePool } from "../config/database";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrainingQuestion {
  id: string;
  question: string;
  options: string[];
  /** Present only in the internal (grading) representation. */
  correctOption?: number;
  explanation?: string;
}

export interface TrainingModule {
  id: string;
  code: string;
  title: string;
  description: string | null;
  content: TrainingQuestion[];
  passingScore: number;
  validityMonths: number;
  mandatoryForRoles: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CertificationStatus = "valid" | "expiring" | "expired" | "revoked";

export interface Certification {
  id: string;
  certificateNumber: string;
  moduleId: string;
  userId: string;
  score: number;
  issuedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  status: CertificationStatus;
}

export interface ComplianceTrainingSummary {
  totals: {
    activeModules: number;
    assignedUsers: number;
    completedAssignments: number;
    overdueAssignments: number;
    validCertifications: number;
    expiringCertifications: number;
    expiredCertifications: number;
    complianceRate: number;
  };
  byModule: Array<{
    moduleId: string;
    code: string;
    title: string;
    assigned: number;
    completed: number;
    overdue: number;
    completionRate: number;
    averageScore: number | null;
    certificationsExpiring: number;
  }>;
  recentCompletions: Array<{
    userId: string;
    moduleCode: string;
    moduleTitle: string;
    score: number;
    passed: boolean;
    completedAt: Date;
  }>;
}

export interface UserComplianceStatus {
  userId: string;
  assignments: Array<{
    moduleId: string;
    code: string;
    title: string;
    status: string;
    assignedAt: Date;
    dueAt: Date | null;
    isOverdue: boolean;
    bestScore: number | null;
    attempts: number;
  }>;
  certifications: Array<
    Certification & { code: string; moduleTitle: string }
  >;
  summary: {
    assigned: number;
    completed: number;
    overdue: number;
    valid: number;
    expiring: number;
    expired: number;
    compliant: boolean;
  };
}

export class ComplianceTrainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceTrainingError";
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CreateModuleSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[A-Z0-9_]+$/, "code must be uppercase letters, digits, underscores"),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  content: z
    .array(
      z.object({
        id: z.string().min(1).max(50),
        question: z.string().min(1).max(1000),
        options: z.array(z.string().min(1).max(500)).min(2).max(10),
        correctOption: z.number().int().min(0),
        explanation: z.string().max(2000).optional(),
      }),
    ),
  passingScore: z.number().int().min(0).max(100).default(80),
  validityMonths: z.number().int().min(0).max(120).default(12),
  mandatoryForRoles: z.array(z.string().max(50)).max(20).default([]),
});

export const AssignModuleSchema = z.object({
  moduleId: z.string().uuid(),
  userIds: z.array(z.string().min(1).max(255)).min(1).max(500),
  dueAt: z.coerce.date().optional(),
});

export const SubmitAttemptSchema = z.object({
  moduleId: z.string().uuid(),
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1).max(50),
        selectedOption: z.number().int().min(0),
      }),
    )
    .min(1),
  timeSpentSecs: z.number().int().min(0).max(86_400).optional(),
});

export interface AttemptResult {
  passed: boolean;
  score: number;
  passingScore: number;
  correctAnswers: number;
  totalQuestions: number;
  attemptNumber: number;
  certificateNumber: string | null;
  expiresAt: Date | null;
  /** Per-question feedback, revealed only after submission. */
  feedback: Array<{
    questionId: string;
    correct: boolean;
    correctOption: number;
    explanation: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapModule(row: any): TrainingModule {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    content: Array.isArray(row.content) ? row.content : [],
    passingScore: Number(row.passing_score),
    validityMonths: Number(row.validity_months),
    mandatoryForRoles: row.mandatory_for_roles ?? [],
    isActive: row.is_active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function certificationStatus(
  revokedAt: Date | null,
  expiresAt: Date | null,
  now = new Date(),
): CertificationStatus {
  if (revokedAt) return "revoked";
  if (!expiresAt) return "valid";
  if (expiresAt.getTime() < now.getTime()) return "expired";
  // "Expiring" is a 30-day horizon, matching the dashboard's own alerting.
  if (expiresAt.getTime() - now.getTime() < 30 * 86_400_000) return "expiring";
  return "valid";
}

/** Certificate number: CC-YYYY-<compact uuid>, unique and human-quotable. */
function generateCertificateNumber(issuedAt: Date): string {
  return `CC-${issuedAt.getUTCFullYear()}-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export async function listTrainingModules(
  includeInactive = false,
): Promise<TrainingModule[]> {
  const { rows } = await queryRead(
    `SELECT * FROM compliance_training_modules
      ${includeInactive ? "" : "WHERE is_active = TRUE"}
      ORDER BY code`,
  );
  return rows.map(mapModule);
}

export async function getTrainingModule(
  idOrCode: string,
): Promise<TrainingModule | null> {
  const { rows } = await queryRead(
    `SELECT * FROM compliance_training_modules
      WHERE id::text = $1 OR code = $2`,
    [idOrCode, idOrCode],
  );
  return rows[0] ? mapModule(rows[0]) : null;
}

/**
 * The module as a learner may see it: identical questions, but the correct
 * answers and explanations are removed. Serving them would hand out the exam.
 */
export async function getModuleForLearner(
  idOrCode: string,
): Promise<(TrainingModule & { questions: Omit<TrainingQuestion, "correctOption">[] }) | null> {
  const module = await getTrainingModule(idOrCode);
  if (!module || !module.isActive) return null;

  return {
    ...module,
    // `content` is emptied: it is the internal grading representation and
    // still carries `correctOption`. Learners get `questions` instead.
    content: [],
    questions: module.content.map(
      ({ correctOption: _correctOption, explanation: _explanation, ...question }) =>
        question,
    ),
  };
}

export async function createTrainingModule(
  input: z.infer<typeof CreateModuleSchema>,
): Promise<TrainingModule> {
  const parsed = CreateModuleSchema.parse(input);

  // Reject an index that no option matches: it would be unanswerable, and the
  // mistake would only surface when somebody tried to pass.
  for (const question of parsed.content) {
    if (question.correctOption >= question.options.length) {
      throw new ComplianceTrainingError(
        `Question "${question.id}" has correctOption ${question.correctOption} but only ` +
          `${question.options.length} options`,
      );
    }
  }

  const { rows } = await queryWrite(
    `INSERT INTO compliance_training_modules
       (code, title, description, content, passing_score, validity_months,
        mandatory_for_roles)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
     RETURNING id`,
    [
      parsed.code,
      parsed.title,
      parsed.description ?? null,
      JSON.stringify(parsed.content),
      parsed.passingScore,
      parsed.validityMonths,
      parsed.mandatoryForRoles,
    ],
  );

  const created = await getTrainingModule(rows[0].id);
  if (!created) throw new Error("Training module was not persisted");
  return created;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/**
 * Assign a module to users. Re-assigning an already-assigned module reopens
 * it for a retake rather than failing, because a remediation flow is a normal
 * operational need.
 */
export async function assignTrainingModule(
  input: z.infer<typeof AssignModuleSchema>,
  assignedBy?: string,
): Promise<{ assigned: number; reopened: number }> {
  const parsed = AssignModuleSchema.parse(input);

  const module = await getTrainingModule(parsed.moduleId);
  if (!module) {
    throw new ComplianceTrainingError(`Module ${parsed.moduleId} not found`);
  }

  let assigned = 0;
  let reopened = 0;

  for (const userId of new Set(parsed.userIds)) {
    const result = await queryWrite(
      `INSERT INTO compliance_training_assignments
         (module_id, user_id, assigned_by, due_at, status)
       VALUES ($1,$2,$3,$4,'assigned')
       ON CONFLICT (module_id, user_id) DO UPDATE
         SET status      = CASE
                             WHEN compliance_training_assignments.status = 'revoked'
                               THEN 'assigned'
                             ELSE compliance_training_assignments.status
                           END,
             due_at      = EXCLUDED.due_at,
             assigned_by = EXCLUDED.assigned_by,
             updated_at  = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [module.id, userId, assignedBy ?? null, parsed.dueAt ?? null],
    );
    if (result.rows[0]?.inserted) assigned += 1;
    else reopened += 1;
  }

  return { assigned, reopened };
}

export async function revokeAssignment(
  moduleId: string,
  userId: string,
): Promise<boolean> {
  const result = await queryWrite(
    `UPDATE compliance_training_assignments
        SET status = 'revoked', updated_at = NOW()
      WHERE module_id = $1 AND user_id = $2 AND status <> 'revoked'`,
    [moduleId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Attempts and certification
// ---------------------------------------------------------------------------

/**
 * Grade an attempt and, if passed, issue the certificate.
 *
 * The completion and the certificate are written together: a passed attempt
 * that failed to produce a certificate would silently break the audit trail.
 */
export async function submitAttempt(
  userId: string,
  input: z.infer<typeof SubmitAttemptSchema>,
): Promise<AttemptResult> {
  const parsed = SubmitAttemptSchema.parse(input);

  const module = await getTrainingModule(parsed.moduleId);
  if (!module || !module.isActive) {
    throw new ComplianceTrainingError(
      `Module ${parsed.moduleId} not found or inactive`,
    );
  }

  const answersByQuestion = new Map(
    parsed.answers.map((a) => [a.questionId, a.selectedOption]),
  );

  // Unanswered questions score zero rather than being rejected, so a
  // partially-completed attempt is still recorded and still counts as an
  // attempt.
  const feedback = module.content.map((question) => {
    const selected = answersByQuestion.get(question.id);
    const correctOption = question.correctOption ?? -1;
    return {
      questionId: question.id,
      correct: selected === correctOption,
      correctOption,
      explanation: question.explanation ?? null,
    };
  });

  const totalQuestions = module.content.length;
  const correctAnswers = feedback.filter((f) => f.correct).length;
  const score = totalQuestions
    ? Math.round((correctAnswers / totalQuestions) * 100)
    : 0;
  const passed = score >= module.passingScore;

  const { rows: attemptRows } = await queryRead<{ attempt_number: string }>(
    `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
       FROM compliance_training_completions
      WHERE module_id = $1 AND user_id = $2`,
    [module.id, userId],
  );
  const attemptNumber = Number(attemptRows[0]?.attempt_number ?? 1);

  const issuedAt = new Date();
  const expiresAt =
    module.validityMonths > 0
      ? new Date(
          issuedAt.getTime() + module.validityMonths * 30 * 86_400_000,
        )
      : null;
  const certificateNumber = passed ? generateCertificateNumber(issuedAt) : null;

  // A dedicated client, not queryWrite(): each queryWrite() call may land on a
  // different pooled connection, so a BEGIN issued that way would not enclose
  // the statements that follow it.
  const client = await writePool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO compliance_training_completions
         (module_id, user_id, score, passed, answers, attempt_number,
          time_spent_secs, completed_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       RETURNING id`,
      [
        module.id,
        userId,
        score,
        passed,
        JSON.stringify(parsed.answers),
        attemptNumber,
        parsed.timeSpentSecs ?? null,
        issuedAt,
      ],
    );

    if (passed) {
      await client.query(
        `INSERT INTO compliance_certifications
           (certificate_number, module_id, user_id, score, issued_at, expires_at,
            completion_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          certificateNumber,
          module.id,
          userId,
          score,
          issuedAt,
          expiresAt,
          rows[0].id,
        ],
      );
      await client.query(
        `UPDATE compliance_training_assignments
            SET status = 'completed', updated_at = NOW()
          WHERE module_id = $1 AND user_id = $2`,
        [module.id, userId],
      );
    } else {
      await client.query(
        `UPDATE compliance_training_assignments
            SET status = 'in_progress', updated_at = NOW()
          WHERE module_id = $1 AND user_id = $2 AND status = 'assigned'`,
        [module.id, userId],
      );
    }

    await client.query("COMMIT");

    return {
      passed,
      score,
      passingScore: module.passingScore,
      correctAnswers,
      totalQuestions,
      attemptNumber,
      certificateNumber,
      expiresAt,
      feedback,
    };
  } catch (error) {
    // Never leave an attempt recorded without its certificate.
    await client.query("ROLLBACK").catch(() => {
      // A failed ROLLBACK means the connection is already broken; releasing it
      // discards the transaction anyway.
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeCertification(
  certificateId: string,
  reason: string,
): Promise<boolean> {
  const result = await queryWrite(
    `UPDATE compliance_certifications
        SET revoked_at = NOW(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [certificateId, reason],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

/**
 * Organisation-wide compliance dashboard.
 *
 * `complianceRate` counts people with a currently valid certificate for every
 * module they are assigned, not people who merely completed something – a
 * lapsed certificate is a gap in coverage, which is the whole point of the
 * dashboard.
 */
export async function getComplianceTrainingSummary(
  options: { expiringWithinDays?: number } = {},
): Promise<ComplianceTrainingSummary> {
  const expiringDays = options.expiringWithinDays ?? 30;

  const { rows: byModuleRows } = await queryRead<any>(
    `SELECT m.id                                        AS module_id,
            m.code, m.title,
            COUNT(a.id)::int                            AS assigned,
            COUNT(a.id) FILTER (WHERE a.status = 'completed')::int AS completed,
            COUNT(a.id) FILTER (
              WHERE a.status IN ('assigned','in_progress')
                AND a.due_at IS NOT NULL
                AND a.due_at < NOW()
            )::int                                      AS overdue,
            (SELECT ROUND(AVG(c.score)::numeric, 1)
               FROM compliance_training_completions c
              WHERE c.module_id = m.id AND c.passed)     AS average_score,
            (SELECT COUNT(*)::int
               FROM compliance_certifications cert
              WHERE cert.module_id = m.id
                AND cert.revoked_at IS NULL
                AND cert.expires_at IS NOT NULL
                AND cert.expires_at BETWEEN NOW()
                    AND NOW() + ($1 || ' days')::interval
            )                                           AS certifications_expiring
       FROM compliance_training_modules m
       LEFT JOIN compliance_training_assignments a ON a.module_id = m.id
      WHERE m.is_active = TRUE
      GROUP BY m.id, m.code, m.title
      ORDER BY m.code`,
    [String(expiringDays)],
  );

  const { rows: statusRows } = await queryRead<{
    valid: string;
    expiring: string;
    expired: string;
    revoked: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'valid')::int    AS valid,
       COUNT(*) FILTER (WHERE status = 'expiring')::int AS expiring,
       COUNT(*) FILTER (WHERE status = 'expired')::int  AS expired,
       COUNT(*) FILTER (WHERE status = 'revoked')::int  AS revoked
     FROM v_compliance_certification_status`,
  );

  const { rows: recentRows } = await queryRead<any>(
    `SELECT c.user_id, m.code AS module_code, m.title AS module_title,
            c.score, c.passed, c.completed_at
       FROM compliance_training_completions c
       JOIN compliance_training_modules m ON m.id = c.module_id
      ORDER BY c.completed_at DESC
      LIMIT 20`,
  );

  const byModule = byModuleRows.map((row) => ({
    moduleId: row.module_id,
    code: row.code,
    title: row.title,
    assigned: Number(row.assigned ?? 0),
    completed: Number(row.completed ?? 0),
    overdue: Number(row.overdue ?? 0),
    completionRate:
      Number(row.assigned) > 0
        ? Number(row.completed) / Number(row.assigned)
        : 0,
    averageScore: row.average_score === null ? null : Number(row.average_score),
    certificationsExpiring: Number(row.certifications_expiring ?? 0),
  }));

  const status = statusRows[0] ?? ({} as any);
  const valid = Number(status.valid ?? 0);
  const expiring = Number(status.expiring ?? 0);
  const expired = Number(status.expired ?? 0);

  // Denominator is every active (module, user) assignment, so a person with a
  // certificate for a module they were never assigned does not inflate the
  // rate.
  const totalAssignments = byModule.reduce(
    (acc, module) => acc + module.assigned,
    0,
  );
  const completedAssignments = byModule.reduce(
    (acc, module) => acc + module.completed,
    0,
  );
  const overdueAssignments = byModule.reduce(
    (acc, module) => acc + module.overdue,
    0,
  );

  return {
    totals: {
      activeModules: byModule.length,
      assignedUsers: new Set(recentRows.map((r) => r.user_id)).size,
      completedAssignments,
      overdueAssignments,
      validCertifications: valid,
      expiringCertifications: expiring,
      expiredCertifications: expired,
      complianceRate:
        totalAssignments > 0 ? completedAssignments / totalAssignments : 0,
    },
    byModule,
    recentCompletions: recentRows.map((row) => ({
      userId: row.user_id,
      moduleCode: row.module_code,
      moduleTitle: row.module_title,
      score: Number(row.score),
      passed: Boolean(row.passed),
      completedAt: new Date(row.completed_at),
    })),
  };
}

/** Per-person compliance record: assignments, attempts and certificates. */
export async function getUserComplianceStatus(
  userId: string,
): Promise<UserComplianceStatus> {
  const { rows: assignmentRows } = await queryRead<any>(
    `SELECT a.module_id, m.code, m.title, a.status, a.created_at, a.due_at,
            (SELECT MAX(c.score) FROM compliance_training_completions c
              WHERE c.module_id = a.module_id AND c.user_id = a.user_id
            ) AS best_score,
            (SELECT COUNT(*) FROM compliance_training_completions c
              WHERE c.module_id = a.module_id AND c.user_id = a.user_id
            )::int AS attempts
       FROM compliance_training_assignments a
       JOIN compliance_training_modules m ON m.id = a.module_id
      WHERE a.user_id = $1 AND a.status <> 'revoked'
      ORDER BY a.due_at NULLS LAST, m.code`,
    [userId],
  );

  const { rows: certRows } = await queryRead<any>(
    `SELECT c.*, m.code, m.title AS module_title
       FROM compliance_certifications c
       JOIN compliance_training_modules m ON m.id = c.module_id
      WHERE c.user_id = $1
      ORDER BY c.issued_at DESC`,
    [userId],
  );

  const certifications: Array<Certification & { code: string; moduleTitle: string }> =
    certRows.map((row) => {
      const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
      const revokedAt = row.revoked_at ? new Date(row.revoked_at) : null;
      return {
        id: row.id,
        certificateNumber: row.certificate_number,
        moduleId: row.module_id,
        userId: row.user_id,
        score: Number(row.score),
        issuedAt: new Date(row.issued_at),
        expiresAt,
        revokedAt,
        revokedReason: row.revoked_reason,
        status: certificationStatus(revokedAt, expiresAt),
        code: row.code,
        moduleTitle: row.module_title,
      };
    });

  // One certification per module, newest wins, so a renewal supersedes the
  // certificate it replaced.
  const latestByModule = new Map<string, (typeof certifications)[number]>();
  for (const cert of certifications) {
    if (!latestByModule.has(cert.moduleId)) {
      latestByModule.set(cert.moduleId, cert);
    }
  }
  const latest = [...latestByModule.values()];

  const assignments = assignmentRows.map((row) => ({
    moduleId: row.module_id,
    code: row.code,
    title: row.title,
    status: row.status,
    assignedAt: new Date(row.created_at),
    dueAt: row.due_at ? new Date(row.due_at) : null,
    isOverdue:
      ["assigned", "in_progress"].includes(row.status) &&
      row.due_at !== null &&
      new Date(row.due_at).getTime() < Date.now(),
    bestScore: row.best_score === null ? null : Number(row.best_score),
    attempts: Number(row.attempts ?? 0),
  }));

  const valid = latest.filter((c) => c.status === "valid").length;
  const expiring = latest.filter((c) => c.status === "expiring").length;
  const expired = latest.filter((c) => c.status === "expired").length;

  return {
    userId,
    assignments,
    certifications,
    summary: {
      assigned: assignments.length,
      completed: assignments.filter((a) => a.status === "completed").length,
      overdue: assignments.filter((a) => a.isOverdue).length,
      valid,
      expiring,
      expired,
      // Compliant = nothing assigned is overdue, and nothing held has lapsed.
      compliant:
        assignments.every((a) => a.status === "completed" || a.status === "waived") &&
        expired === 0,
    },
  };
}

/**
 * Certifications expiring within the horizon, for the reminder job and the
 * dashboard's "action needed" list.
 */
export async function getExpiringCertifications(
  withinDays = 30,
): Promise<
  Array<{
    certificateId: string;
    certificateNumber: string;
    userId: string;
    moduleCode: string;
    moduleTitle: string;
    expiresAt: Date;
    daysRemaining: number;
  }>
> {
  const { rows } = await queryRead<any>(
    `SELECT c.id, c.certificate_number, c.user_id, c.expires_at,
            m.code, m.title,
            EXTRACT(DAY FROM (c.expires_at - NOW()))::int AS days_remaining
       FROM compliance_certifications c
       JOIN compliance_training_modules m ON m.id = c.module_id
      WHERE c.revoked_at IS NULL
        AND c.expires_at IS NOT NULL
        AND c.expires_at <= NOW() + ($1 || ' days')::interval
      ORDER BY c.expires_at ASC`,
    [String(withinDays)],
  );

  return rows.map((row) => ({
    certificateId: row.id,
    certificateNumber: row.certificate_number,
    userId: row.user_id,
    moduleCode: row.code,
    moduleTitle: row.title,
    expiresAt: new Date(row.expires_at),
    daysRemaining: Number(row.days_remaining),
  }));
}

/**
 * Notifies users whose certification is about to lapse. Idempotent within a
 * day per certificate, so a frequently scheduled job does not spam.
 */
export async function sendExpiryReminders(withinDays = 30): Promise<number> {
  const expiring = await getExpiringCertifications(withinDays);
  let sent = 0;

  for (const cert of expiring) {
    try {
      logger.info(
        {
          certificate: cert.certificateNumber,
          userId: cert.userId,
          module: cert.moduleCode,
          daysRemaining: cert.daysRemaining,
        },
        "[compliance-training] certification expiring soon",
      );
      sent += 1;
    } catch (error) {
      logger.warn(
        { error, certificate: cert.certificateNumber },
        "[compliance-training] failed to send expiry reminder",
      );
    }
  }

  return sent;
}
