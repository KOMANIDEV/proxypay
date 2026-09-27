/**
 * #481 – Compliance training and certification
 *
 * The two properties worth guarding are: an answer key never reaches the
 * learner, and a passed attempt always produces a certificate.
 */

jest.mock("../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
  writePool: { connect: jest.fn() },
}));

import { queryRead, queryWrite, writePool } from "../../src/config/database";
import {
  ComplianceTrainingError,
  assignTrainingModule,
  createTrainingModule,
  getModuleForLearner,
  getUserComplianceStatus,
  submitAttempt,
} from "../../src/services/complianceTrainingService";

const mockRead = queryRead as jest.Mock;
const mockWrite = queryWrite as jest.Mock;
const mockConnect = writePool.connect as jest.Mock;

const MODULE_ROW = {
  id: "mod-1",
  code: "AML_FUNDAMENTALS",
  title: "AML Fundamentals",
  description: "Core AML obligations",
  content: [
    {
      id: "q1",
      question: "What is the purpose of CDD?",
      options: ["Revenue", "Verify identity and assess risk", "Latency", "Archive"],
      correctOption: 1,
      explanation: "CDD establishes identity and risk.",
    },
    {
      id: "q2",
      question: "A transaction is suspicious. Next step?",
      options: ["Process it", "Delete it", "File an SAR", "Ignore it"],
      correctOption: 2,
      explanation: "An SAR escalates the suspicion.",
    },
  ],
  passing_score: 80,
  validity_months: 12,
  mandatory_for_roles: ["compliance_officer"],
  is_active: true,
  created_at: new Date("2026-09-01T00:00:00Z"),
  updated_at: new Date("2026-09-01T00:00:00Z"),
};

function mockTransactionClient(overrides: Record<string, unknown> = {}) {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [{ id: "completion-1" }] }),
    release: jest.fn(),
    ...overrides,
  };
  mockConnect.mockResolvedValue(client);
  return client;
}

describe("compliance training (#481)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createTrainingModule", () => {
    it("rejects a correctOption that no option matches", async () => {
      // An unanswerable question would only be discovered when somebody tried
      // to pass the module.
      await expect(
        createTrainingModule({
          code: "BROKEN",
          title: "Broken module",
          content: [
            { id: "q1", question: "Q?", options: ["a", "b"], correctOption: 5 },
          ],
          passingScore: 80,
          validityMonths: 12,
          mandatoryForRoles: [],
        }),
      ).rejects.toThrow(ComplianceTrainingError);
    });

    it("rejects a code that is not an identifier", async () => {
      await expect(
        createTrainingModule({
          code: "lowercase code",
          title: "Bad code",
          content: [
            { id: "q1", question: "Q?", options: ["a", "b"], correctOption: 0 },
          ],
          passingScore: 80,
          validityMonths: 12,
          mandatoryForRoles: [],
        }),
      ).rejects.toThrow();
    });

    it("persists a valid module and returns it", async () => {
      mockRead.mockResolvedValue({ rows: [MODULE_ROW] });
      mockWrite.mockResolvedValue({ rows: [{ id: "mod-1" }] });

      const module = await createTrainingModule({
        code: "AML_FUNDAMENTALS",
        title: "AML Fundamentals",
        content: MODULE_ROW.content,
        passingScore: 80,
        validityMonths: 12,
        mandatoryForRoles: [],
      });

      expect(module.code).toBe("AML_FUNDAMENTALS");
      expect(mockWrite.mock.calls[0][0]).toContain(
        "INSERT INTO compliance_training_modules",
      );
    });
  });

  describe("getModuleForLearner", () => {
    it("strips the correct answers and explanations", async () => {
      mockRead.mockResolvedValueOnce({ rows: [MODULE_ROW] });

      const module = await getModuleForLearner("AML_FUNDAMENTALS");

      // Serving the answer key would hand out the exam.
      expect(module?.questions).toHaveLength(2);
      for (const question of module!.questions) {
        expect(question).not.toHaveProperty("correctOption");
        expect(question).not.toHaveProperty("explanation");
        expect(question.options).toHaveLength(4);
      }
      expect(module?.content).toEqual([]);
    });

    it("returns null for an inactive module", async () => {
      mockRead.mockResolvedValueOnce({
        rows: [{ ...MODULE_ROW, is_active: false }],
      });

      expect(await getModuleForLearner("AML_FUNDAMENTALS")).toBeNull();
    });
  });

  describe("assignTrainingModule", () => {
    it("refuses to assign a module that does not exist", async () => {
      mockRead.mockResolvedValueOnce({ rows: [] });

      await expect(
        assignTrainingModule({
          moduleId: "00000000-0000-0000-0000-000000000000",
          userIds: ["user-1"],
        }),
      ).rejects.toThrow(ComplianceTrainingError);
    });

    it("de-duplicates the user list", async () => {
      mockRead.mockResolvedValueOnce({ rows: [MODULE_ROW] });
      mockWrite.mockResolvedValue({ rows: [{ inserted: true }] });

      const result = await assignTrainingModule({
        moduleId: "mod-1",
        userIds: ["user-1", "user-1", "user-2"],
      });

      expect(mockWrite).toHaveBeenCalledTimes(2);
      expect(result.assigned).toBe(2);
    });

    it("reports a re-assignment as a reopen rather than a failure", async () => {
      mockRead.mockResolvedValueOnce({ rows: [MODULE_ROW] });
      mockWrite.mockResolvedValue({ rows: [{ inserted: false }] });

      const result = await assignTrainingModule({
        moduleId: "mod-1",
        userIds: ["user-1"],
      });

      expect(result.reopened).toBe(1);
      expect(result.assigned).toBe(0);
    });
  });

  describe("submitAttempt", () => {
    beforeEach(() => {
      // getTrainingModule, then the attempt-number query.
      mockRead
        .mockResolvedValueOnce({ rows: [MODULE_ROW] })
        .mockResolvedValueOnce({ rows: [{ attempt_number: "2" }] });
    });

    it("passes a correct attempt and issues a certificate", async () => {
      const client = mockTransactionClient();

      const result = await submitAttempt("user-1", {
        moduleId: "mod-1",
        answers: [
          { questionId: "q1", selectedOption: 1 },
          { questionId: "q2", selectedOption: 2 },
        ],
      });

      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
      expect(result.attemptNumber).toBe(2);
      expect(result.certificateNumber).toMatch(/^CC-\d{4}-[0-9A-F]{12}$/);
      expect(result.expiresAt).toBeInstanceOf(Date);

      const statements = client.query.mock.calls.map((c) => c[0] as string);
      expect(statements[0]).toBe("BEGIN");
      expect(
        statements.some((s) => s.includes("INSERT INTO compliance_training_completions")),
      ).toBe(true);
      expect(
        statements.some((s) => s.includes("INSERT INTO compliance_certifications")),
      ).toBe(true);
      expect(statements).toContain("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });

    it("fails an attempt that misses the pass mark and issues no certificate", async () => {
      const client = mockTransactionClient();

      const result = await submitAttempt("user-1", {
        moduleId: "mod-1",
        answers: [
          { questionId: "q1", selectedOption: 1 },
          { questionId: "q2", selectedOption: 0 },
        ],
      });

      expect(result.score).toBe(50);
      expect(result.passed).toBe(false);
      expect(result.certificateNumber).toBeNull();
      expect(result.expiresAt).toBeNull();

      const statements = client.query.mock.calls.map((c) => c[0] as string);
      expect(
        statements.some((s) => s.includes("INSERT INTO compliance_certifications")),
      ).toBe(false);
    });

    it("treats an unanswered question as wrong rather than rejecting the attempt", async () => {
      mockTransactionClient();

      const result = await submitAttempt("user-1", {
        moduleId: "mod-1",
        answers: [{ questionId: "q1", selectedOption: 1 }],
      });

      expect(result.totalQuestions).toBe(2);
      expect(result.score).toBe(50);
      expect(result.feedback.find((f) => f.questionId === "q2")?.correct).toBe(false);
    });

    it("rolls back so a passed attempt can never exist without its certificate", async () => {
      const client = mockTransactionClient();
      // Fail on the certificate insert, after the completion was written.
      client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "completion-1" }] })
        .mockRejectedValueOnce(new Error("certificate insert failed"));

      await expect(
        submitAttempt("user-1", {
          moduleId: "mod-1",
          answers: [
            { questionId: "q1", selectedOption: 1 },
            { questionId: "q2", selectedOption: 2 },
          ],
        }),
      ).rejects.toThrow("certificate insert failed");

      const statements = client.query.mock.calls.map((c) => c[0] as string);
      expect(statements).toContain("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });

    it("reveals the answer key only after submission", async () => {
      mockTransactionClient();

      const result = await submitAttempt("user-1", {
        moduleId: "mod-1",
        answers: [{ questionId: "q1", selectedOption: 1 }],
      });

      // Feedback is returned post-submission, which is the only time the
      // correct option and explanation may be disclosed.
      expect(result.feedback).toHaveLength(2);
      expect(result.feedback[0].explanation).toBe("CDD establishes identity and risk.");
    });

    it("rejects an attempt against an unknown module", async () => {
      mockRead.mockReset();
      mockRead.mockResolvedValueOnce({ rows: [] });

      await expect(
        submitAttempt("user-1", {
          moduleId: "missing",
          answers: [{ questionId: "q1", selectedOption: 0 }],
        }),
      ).rejects.toThrow(ComplianceTrainingError);
    });
  });

  describe("getUserComplianceStatus", () => {
    it("counts only the newest certificate per module", async () => {
      // A renewal supersedes the certificate it replaced, so a lapsed old
      // certificate must not keep the person marked as non-compliant.
      mockRead
        .mockResolvedValueOnce({
          rows: [
            {
              module_id: "mod-1",
              code: "AML_FUNDAMENTALS",
              title: "AML Fundamentals",
              status: "completed",
              created_at: new Date("2026-01-01T00:00:00Z"),
              due_at: null,
              best_score: 95,
              attempts: 1,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "cert-new",
              certificate_number: "CC-2026-NEW",
              module_id: "mod-1",
              user_id: "user-1",
              score: 95,
              issued_at: new Date("2026-06-01T00:00:00Z"),
              expires_at: new Date("2027-06-01T00:00:00Z"),
              revoked_at: null,
              revoked_reason: null,
              code: "AML_FUNDAMENTALS",
              module_title: "AML Fundamentals",
            },
            {
              id: "cert-old",
              certificate_number: "CC-2025-OLD",
              module_id: "mod-1",
              user_id: "user-1",
              score: 80,
              issued_at: new Date("2025-01-01T00:00:00Z"),
              expires_at: new Date("2026-01-01T00:00:00Z"),
              revoked_at: null,
              revoked_reason: null,
              code: "AML_FUNDAMENTALS",
              module_title: "AML Fundamentals",
            },
          ],
        });

      const status = await getUserComplianceStatus("user-1");

      expect(status.certifications).toHaveLength(2);
      expect(status.summary.valid).toBe(1);
      expect(status.summary.expired).toBe(0);
      expect(status.summary.compliant).toBe(true);
    });

    it("is not compliant while a certificate is expired or work is overdue", async () => {
      mockRead
        .mockResolvedValueOnce({
          rows: [
            {
              module_id: "mod-1",
              code: "AML_FUNDAMENTALS",
              title: "AML Fundamentals",
              status: "in_progress",
              created_at: new Date("2026-01-01T00:00:00Z"),
              due_at: new Date("2026-02-01T00:00:00Z"),
              best_score: 50,
              attempts: 1,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      const status = await getUserComplianceStatus("user-1");

      expect(status.assignments[0].isOverdue).toBe(true);
      expect(status.summary.overdue).toBe(1);
      expect(status.summary.compliant).toBe(false);
    });
  });
});
