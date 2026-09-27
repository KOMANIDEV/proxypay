import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import { WebhookCircuitBreaker } from "../../src/services/webhookCircuitBreaker";

// requireAuth is covered elsewhere; stub it so the suite tests only the new endpoints.
jest.mock("../../src/middleware/auth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = { id: "admin-1", role: "admin" };
    next();
  },
}));

jest.mock("../../src/services/webhookRetryPolicyService", () => ({
  WebhookRetryPolicyService: class {
    async list() {
      return { policies: [], total: 0 };
    }
    async getById() {
      return null;
    }
  },
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import webhookAdminRouter from "../../src/routes/webhookAdmin";
import { WebhookCircuitBreakerRegistry } from "../../src/services/webhookCircuitBreaker";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/webhooks", webhookAdminRouter);
  return app;
}

describe("webhookAdmin circuit-breaker endpoints (#573)", () => {
  let breaker: WebhookCircuitBreaker;

  beforeEach(() => {
    breaker = WebhookCircuitBreakerRegistry.get("https://admin.test/hook", {
      failureThreshold: 1,
      recoveryTimeMs: 24 * 60 * 60 * 1000,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    breaker.reset();
  });

  describe("GET /circuit-breakers?url=...", () => {
    it("returns the breaker snapshot", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");

      const res = await request(buildApp())
        .get("/api/admin/webhooks/circuit-breakers")
        .query({ url: "https://admin.test/hook" })
        .expect(200);

      expect(res.body).toMatchObject({
        url: "https://admin.test/hook",
        state: "open",
        consecutiveFailures: 2,
      });
      expect(res.body.openedAt).toBeTruthy();
      expect(res.body.recoveryAt).toBeTruthy();
    });

    it("400 when url query param is missing", async () => {
      await request(buildApp()).get("/api/admin/webhooks/circuit-breakers").expect(400);
    });
  });

  describe("POST /circuit-breakers/reset", () => {
    it("resets an open breaker to closed", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");

      const res = await request(buildApp())
        .post("/api/admin/webhooks/circuit-breakers/reset")
        .send({ url: "https://admin.test/hook" })
        .expect(200);

      expect(res.body).toMatchObject({
        reset: true,
        url: "https://admin.test/hook",
        state: "closed",
        consecutiveFailures: 0,
      });
      expect(breaker.getState()).toBe("closed");
    });

    it("404 when no breaker is registered for the url", async () => {
      await request(buildApp())
        .post("/api/admin/webhooks/circuit-breakers/reset")
        .send({ url: "https://unknown.test/hook" })
        .expect(404);
    });

    it("400 when url is missing from the body", async () => {
      await request(buildApp())
        .post("/api/admin/webhooks/circuit-breakers/reset")
        .send({})
        .expect(400);
    });
  });
});
