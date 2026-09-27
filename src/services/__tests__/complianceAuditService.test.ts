import { queryWrite } from "../../config/database";
import {
  COMPLIANCE_AUDIT_ACTIONS,
  buildComplianceAuditRecord,
  logComplianceAudit,
  logKycTierOverride,
} from "../complianceAuditService";

jest.mock("../../config/database", () => ({
  queryWrite: jest.fn(),
}));

const mockedQueryWrite = queryWrite as jest.Mock;

describe("complianceAuditService (#640)", () => {
  beforeEach(() => {
    mockedQueryWrite.mockReset();
    mockedQueryWrite.mockResolvedValue({ rows: [] });
  });

  describe("buildComplianceAuditRecord", () => {
    it("captures the admin id and override reason", () => {
      const record = buildComplianceAuditRecord({
        actorId: "admin-1",
        actorRole: "admin",
        action: COMPLIANCE_AUDIT_ACTIONS.KYC_TIER_OVERRIDE,
        resourceType: "user",
        resourceId: "user-1",
        reason: "Manual override after document review",
        previousValue: { kycLevel: "unverified" },
        newValue: { kycLevel: "full" },
      });

      expect(record.id).toMatch(/^compliance_audit_/);
      expect(record.actor_id).toBe("admin-1");
      expect(record.reason).toBe("Manual override after document review");
      expect(record.previous_value).toEqual({ kycLevel: "unverified" });
      expect(record.new_value).toEqual({ kycLevel: "full" });
      expect(record.created_at).toBeTruthy();
    });

    it("rejects records without an actor id", () => {
      expect(() =>
        buildComplianceAuditRecord({
          actorId: "",
          action: COMPLIANCE_AUDIT_ACTIONS.KYC_TIER_OVERRIDE,
          resourceType: "user",
          resourceId: "user-1",
        }),
      ).toThrow(/actor id/);
    });

    it("rejects records without a resource id", () => {
      expect(() =>
        buildComplianceAuditRecord({
          actorId: "admin-1",
          action: COMPLIANCE_AUDIT_ACTIONS.KYC_TIER_OVERRIDE,
          resourceType: "user",
          resourceId: "",
        }),
      ).toThrow(/resource id/);
    });
  });

  describe("logComplianceAudit", () => {
    it("inserts the record into the compliance audit table", async () => {
      await logComplianceAudit({
        actorId: "admin-1",
        action: COMPLIANCE_AUDIT_ACTIONS.KYC_TIER_OVERRIDE,
        resourceType: "user",
        resourceId: "user-1",
        reason: "override required",
        previousValue: { kycLevel: "none" },
        newValue: { kycLevel: "basic" },
      });

      expect(mockedQueryWrite).toHaveBeenCalledTimes(1);
      const [sql, params] = mockedQueryWrite.mock.calls[0];
      expect(sql).toContain("INSERT INTO compliance_audit_log");
      expect(params[1]).toBe("admin-1");
      expect(params[3]).toBe(COMPLIANCE_AUDIT_ACTIONS.KYC_TIER_OVERRIDE);
      expect(params[5]).toBe("user-1");
      expect(params[6]).toBe("override required");
      expect(params[7]).toBe(JSON.stringify({ kycLevel: "none" }));
      expect(params[8]).toBe(JSON.stringify({ kycLevel: "basic" }));
    });

    it("uses the provided transaction client when supplied", async () => {
      const clientQuery = jest.fn().mockResolvedValue({ rows: [] });

      await logComplianceAudit(
        {
          actorId: "admin-1",
          action: COMPLIANCE_AUDIT_ACTIONS.KYC_TIER_OVERRIDE,
          resourceType: "user",
          resourceId: "user-1",
        },
        { query: clientQuery },
      );

      expect(clientQuery).toHaveBeenCalledTimes(1);
      expect(mockedQueryWrite).not.toHaveBeenCalled();
    });
  });

  describe("logKycTierOverride", () => {
    it("records the action, admin id and reason", async () => {
      await logKycTierOverride({
        userId: "user-1",
        previousLevel: "unverified",
        newLevel: "basic",
        adminId: "admin-9",
        reason: "Documents approved",
      });

      const [, params] = mockedQueryWrite.mock.calls[0];
      expect(params[1]).toBe("admin-9");
      expect(params[3]).toBe(COMPLIANCE_AUDIT_ACTIONS.KYC_TIER_OVERRIDE);
      expect(params[5]).toBe("user-1");
      expect(params[6]).toBe("Documents approved");
      expect(params[7]).toBe(JSON.stringify({ kycLevel: "unverified" }));
      expect(params[8]).toBe(JSON.stringify({ kycLevel: "basic" }));
    });

    it("falls back to a default override reason", async () => {
      await logKycTierOverride({
        userId: "user-1",
        previousLevel: null,
        newLevel: "full",
        adminId: "admin-9",
      });

      const [, params] = mockedQueryWrite.mock.calls[0];
      expect(params[6]).toBe("Admin KYC tier override");
    });

    it("passes the transaction client through", async () => {
      const clientQuery = jest.fn().mockResolvedValue({ rows: [] });

      await logKycTierOverride({
        userId: "user-1",
        previousLevel: "basic",
        newLevel: "full",
        adminId: "admin-9",
        client: { query: clientQuery },
      });

      expect(clientQuery).toHaveBeenCalledTimes(1);
      expect(mockedQueryWrite).not.toHaveBeenCalled();
    });
  });
});
