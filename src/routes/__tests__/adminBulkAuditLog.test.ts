/**
 * Tests for bulk admin action audit logging (issue #620).
 *
 * Every bulk admin operation must leave a durable row in `audit_logs` carrying
 * the acting admin, the affected record ids and the change that was applied,
 * and the dashboard viewer must be able to filter that trail.
 */

import request from "supertest";
import express from "express";

const mockLogBulkAdminAudit = jest.fn().mockResolvedValue(undefined);
const mockSearchAuditLogs = jest.fn();
const mockUserFindById = jest.fn();
const mockUserUpdateStatus = jest.fn();

jest.mock("../../utils/log-audit-event", () => ({
  logBulkAdminAudit: (...args: unknown[]) => mockLogBulkAdminAudit(...args),
  searchAuditLogs: (...args: unknown[]) => mockSearchAuditLogs(...args),
}));

jest.mock("../../models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({
    findById: (...args: unknown[]) => mockUserFindById(...args),
    updateStatus: (...args: unknown[]) => mockUserUpdateStatus(...args),
  })),
}));

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    ping: jest.fn().mockResolvedValue("PONG"),
  },
}));

import { adminRoutes } from "../admin";
import { errorHandler } from "../../middleware/errorHandler";

function createApp() {
  const app = express();
  app.use(express.json());

  // Mock auth middleware to set an admin user
  app.use((req, _res, next) => {
    (req as any).user = { id: "admin-123", role: "admin" };
    next();
  });

  app.use("/api/admin", adminRoutes);
  app.use(errorHandler);
  return app;
}

describe("Bulk admin action audit logging (#620)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLogBulkAdminAudit.mockResolvedValue(undefined);
  });

  it("records the acting admin and affected ids for a bulk freeze", async () => {
    mockUserFindById.mockResolvedValue({ id: "user-1", status: "active" });
    mockUserUpdateStatus.mockResolvedValue({ id: "user-1", status: "frozen" });

    const res = await request(createApp())
      .post("/api/admin/users/bulk/freeze")
      .send({ userIds: ["user-1"], reason: "fraud review" });

    expect(res.status).toBe(200);
    expect(mockLogBulkAdminAudit).toHaveBeenCalledTimes(1);
    expect(mockLogBulkAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-123",
        action: "BULK_FREEZE_USERS",
        resource: "user",
        resourceIds: ["user-1"],
        reason: "fraud review",
        changes: expect.objectContaining({
          status: "frozen",
          requestedIds: ["user-1"],
          failedIds: [],
        }),
      }),
    );
  });

  it("records only the ids the bulk unfreeze actually changed", async () => {
    mockUserFindById
      .mockResolvedValueOnce({ id: "user-1", status: "frozen" })
      .mockResolvedValueOnce({ id: "user-2", status: "active" });
    mockUserUpdateStatus.mockResolvedValue({ id: "user-1", status: "active" });

    const res = await request(createApp())
      .post("/api/admin/users/bulk/unfreeze")
      .send({ userIds: ["user-1", "user-2"], reason: "appeal upheld" });

    expect(res.status).toBe(200);
    expect(mockLogBulkAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BULK_UNFREEZE_USERS",
        resourceIds: ["user-1"],
        changes: expect.objectContaining({
          status: "active",
          requestedIds: ["user-1", "user-2"],
          failedIds: ["user-2"],
        }),
      }),
    );
  });

  it("records a bulk unlock without a reason", async () => {
    const res = await request(createApp())
      .post("/api/admin/users/bulk/unlock")
      .send({ userIds: ["user-9"] });

    expect(res.status).toBe(200);
    expect(mockLogBulkAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-123",
        action: "BULK_UNLOCK_USERS",
        changes: expect.objectContaining({ locked: false }),
      }),
    );
  });

  it("does not write an audit row when the request is rejected", async () => {
    const res = await request(createApp())
      .post("/api/admin/users/bulk/freeze")
      .send({ userIds: [], reason: "fraud review" });

    expect(res.status).toBe(400);
    expect(mockLogBulkAdminAudit).not.toHaveBeenCalled();
  });
});

describe("Admin audit log viewer (#620)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a filtered page of audit events", async () => {
    mockSearchAuditLogs.mockResolvedValue({
      logs: [{ action: "BULK_FREEZE_USERS", adminId: "admin-123" }],
      total: 1,
      limit: 10,
      offset: 0,
    });

    const res = await request(createApp()).get(
      "/api/admin/audit-logs?action=BULK_FREEZE_USERS&adminId=admin-123&limit=10",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, total: 1 });
    expect(mockSearchAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BULK_FREEZE_USERS",
        adminId: "admin-123",
        limit: 10,
      }),
    );
  });

  it("rejects an invalid date bound", async () => {
    const res = await request(createApp()).get(
      "/api/admin/audit-logs?from=not-a-date",
    );

    expect(res.status).toBe(400);
    expect(mockSearchAuditLogs).not.toHaveBeenCalled();
  });

  it("renders the audit trail as HTML", async () => {
    mockSearchAuditLogs.mockResolvedValue({
      logs: [
        {
          adminId: "admin-123",
          action: "BULK_FREEZE_USERS",
          resource: "user",
          resourceId: "user-1",
          diff: { affectedIds: ["user-1"] },
          ipAddress: "127.0.0.1",
          timestamp: new Date().toISOString(),
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });

    const res = await request(createApp()).get("/api/admin/audit-logs/view");

    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html");
    expect(res.text).toContain("BULK_FREEZE_USERS");
    expect(res.text).toContain("admin-123");
  });
});
