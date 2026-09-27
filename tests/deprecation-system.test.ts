/**
 * Tests for #393 — API Endpoint Deprecation Notice System
 *  - Deprecation / Sunset / Link headers on legacy endpoints
 *  - Deprecation registry timeline
 *  - Prometheus monitoring of deprecated endpoint usage
 *  - Admin endpoint exposing the timeline, usage, and migration guides
 */

import request from "supertest";
import express, { Response as ExpressResponse } from "express";
import {
  DeprecationRegistry,
  deprecationMiddleware,
  recordDeprecatedUsage,
} from "../src/middleware/deprecation";
import { seedDeprecations } from "../src/middleware/deprecationSeed";
import { adminDeprecationRoutes } from "../src/routes/admin/deprecations";
import { deprecatedEndpointRequestsTotal, register } from "../src/utils/metrics";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(deprecationMiddleware);
  app.use("/api/transactions", (_req, res: ExpressResponse) => {
    res.json({ ok: true });
  });
  app.use("/api/bulk", (_req, res: ExpressResponse) => {
    res.json({ ok: true });
  });
  app.use("/api/admin/deprecations", adminDeprecationRoutes);
  return app;
}

describe("#393 API Endpoint Deprecation Notice System", () => {
  let app: express.Application;

  beforeEach(() => {
    DeprecationRegistry.clear();
    seedDeprecations();
    deprecatedEndpointRequestsTotal.reset();
    app = buildApp();
  });

  afterEach(() => {
    DeprecationRegistry.clear();
    deprecatedEndpointRequestsTotal.reset();
  });

  describe("Deprecation response headers on legacy endpoints", () => {
    it("adds Deprecation, Sunset, and Link headers to a registered legacy path", (done) => {
      request(app)
        .get("/api/transactions")
        .expect(200)
        .expect((res: any) => {
          if (res.headers["deprecation"] !== "true")
            throw new Error("Expected Deprecation: true");
          if (!res.headers["sunset"])
            throw new Error("Expected a Sunset header");
          if (
            !String(res.headers["link"] || "").includes(
              "/api/v1/transactions",
            )
          )
            throw new Error("Expected Link header to successor version");
        })
        .end(done);
    });

    it("adds headers for sub-paths of a deprecated prefix", (done) => {
      request(app)
        .get("/api/transactions/deposit")
        .expect(200)
        .expect((res: any) => {
          if (res.headers["deprecation"] !== "true")
            throw new Error("Expected Deprecation: true for sub-path");
        })
        .end(done);
    });

    it("adds headers for the bulk alias", (done) => {
      request(app)
        .get("/api/bulk")
        .expect(200)
        .expect((res: any) => {
          if (res.headers["deprecation"] !== "true")
            throw new Error("Expected Deprecation on /api/bulk");
        })
        .end(done);
    });
  });

  describe("Deprecation registry timeline", () => {
    it("returns the seeded endpoints with sunset metadata", () => {
      const timeline = DeprecationRegistry.getTimeline();
      expect(timeline.length).toBeGreaterThan(0);
      const tx = timeline.find((e) => e.path === "/api/transactions");
      expect(tx).toBeDefined();
      expect(tx?.method).toBe("ALL");
      expect(tx?.replacement).toBe("/api/v1/transactions");
      expect(tx?.status).toBe("announced");
      expect(typeof tx?.daysUntilSunset).toBe("number");
    });
  });

  describe("Monitoring of deprecated endpoint usage", () => {
    it("increments the Prometheus counter when a deprecated endpoint is hit", async () => {
      await request(app).get("/api/transactions");
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find(
        (m) => m.name === "deprecated_endpoint_requests_total",
      );
      expect(counter).toBeDefined();
      const total = counter!.values.reduce(
        (sum, v) => sum + (typeof v.value === "number" ? v.value : 0),
        0,
      );
      expect(total).toBeGreaterThan(0);
    });

    it("recordDeprecatedUsage labels the counter correctly", async () => {
      recordDeprecatedUsage({
        method: "POST",
        path: "/api/transactions/deposit",
        replacement: "/api/v1/transactions/deposit",
        sunset: new Date("2099-01-01"),
      });
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find(
        (m) => m.name === "deprecated_endpoint_requests_total",
      );
      const hit = counter!.values.find(
        (v) => v.labels?.route === "/api/transactions/deposit",
      );
      expect(hit).toBeDefined();
      expect(hit!.value).toBe(1);
    });
  });

  describe("Admin endpoint: deprecation timeline & usage", () => {
    it("returns the deprecation timeline", (done) => {
      request(app)
        .get("/api/admin/deprecations")
        .expect(200)
        .expect((res: any) => {
          expect(Array.isArray(res.body.endpoints)).toBe(true);
          expect(Array.isArray(res.body.apiVersions)).toBe(true);
          expect(Array.isArray(res.body.openApiAnnotations)).toBe(true);
        })
        .end(done);
    });

    it("returns the usage stats", async () => {
      await request(app).get("/api/transactions");
      const res = await request(app).get("/api/admin/deprecations/usage");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.usage)).toBe(true);
    });

    it("returns the migration guide links", (done) => {
      request(app)
        .get("/api/admin/deprecations/migration-guide")
        .expect(200)
        .expect((res: any) => {
          expect(Array.isArray(res.body.guides)).toBe(true);
          expect(res.body.guides.length).toBeGreaterThan(0);
        })
        .end(done);
    });
  });
});
