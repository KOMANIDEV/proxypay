/**
 * Tests for #415 — Mobile App API Versioning Strategy
 *  - API version selection by app version (X-App-Version header)
 *  - Feature flags per API version
 *  - Deprecation timeline (Sunset / Link headers)
 *  - Backward compatibility
 */

import request from "supertest";
import express, { Response as ExpressResponse } from "express";
import {
  apiVersionMiddleware,
  validateVersionMiddleware,
  VersionedRequest,
  supportsFeature,
  requestSupportsFeature,
  createVersionedResponse,
  getDeprecationTimeline,
  SUPPORTED_VERSIONS,
  CURRENT_VERSION,
} from "../src/middleware/apiVersion";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(apiVersionMiddleware);
  app.use(validateVersionMiddleware);

  app.get("/api/:version/test", (req: VersionedRequest, res: ExpressResponse) => {
    res.json({
      version: req.apiVersion,
      appVersion: req.appVersion,
      featureFlags: req.featureFlags,
    });
  });

  app.get("/api/test", (req: VersionedRequest, res: ExpressResponse) => {
    res.json({
      version: req.apiVersion,
      appVersion: req.appVersion,
      featureFlags: req.featureFlags,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("#415 Mobile App API Versioning Strategy", () => {
  let app: express.Application;

  beforeEach(() => {
    app = buildTestApp();
  });

  // -------------------------------------------------------------------------
  // API version extraction — existing behaviour preserved
  // -------------------------------------------------------------------------

  describe("Version Extraction from URL (backward compat)", () => {
    it("extracts v1 from URL path", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect(200)
        .expect((res: any) => {
          if (res.body.version !== "v1")
            throw new Error(`Expected v1, got ${res.body.version}`);
          if (res.headers["api-version"] !== "v1")
            throw new Error("API-Version header missing");
        })
        .end(done);
    });

    it("sets Vary header on all responses", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect((res: any) => {
          const vary = res.headers["vary"] || "";
          if (!vary.includes("Accept"))
            throw new Error("Vary should include Accept");
          if (!vary.includes("Accept-Version"))
            throw new Error("Vary should include Accept-Version");
        })
        .end(done);
    });

    it("defaults to v1 for unversioned endpoints", (done) => {
      request(app)
        .get("/api/test")
        .expect((res: any) => {
          if (res.headers["api-version"] !== "v1")
            throw new Error(`Expected v1 default, got ${res.headers["api-version"]}`);
        })
        .end(done);
    });

    it("rejects unsupported version v99", (done) => {
      request(app)
        .get("/api/v99/test")
        .expect(400)
        .expect((res: any) => {
          if (res.body.error !== "Unsupported API Version")
            throw new Error("Expected Unsupported API Version error");
          if (!Array.isArray(res.body.supportedVersions))
            throw new Error("Expected supportedVersions array");
        })
        .end(done);
    });
  });

  // -------------------------------------------------------------------------
  // X-App-Version header → API version mapping
  // -------------------------------------------------------------------------

  describe("API version selection by app version", () => {
    it("maps app version 2.0.0 to API v2", (done) => {
      request(app)
        .get("/api/test")
        .set("X-App-Version", "2.0.0")
        .expect(200)
        .expect((res: any) => {
          if (res.body.version !== "v2")
            throw new Error(`App 2.0.0 should map to v2, got ${res.body.version}`);
          if (res.body.appVersion !== "2.0.0")
            throw new Error("appVersion not set on request");
        })
        .end(done);
    });

    it("maps app version 1.5.0 to API v1", (done) => {
      request(app)
        .get("/api/test")
        .set("X-App-Version", "1.5.0")
        .expect(200)
        .expect((res: any) => {
          if (res.body.version !== "v1")
            throw new Error(`App 1.5.0 should map to v1, got ${res.body.version}`);
        })
        .end(done);
    });

    it("maps app version 2.5.3 to API v2 (semver gte)", (done) => {
      request(app)
        .get("/api/test")
        .set("X-App-Version", "2.5.3")
        .expect(200)
        .expect((res: any) => {
          if (res.body.version !== "v2")
            throw new Error(`App 2.5.3 should map to v2, got ${res.body.version}`);
        })
        .end(done);
    });

    it("URL path version takes priority over X-App-Version", (done) => {
      request(app)
        .get("/api/v1/test")
        .set("X-App-Version", "2.0.0")
        .expect(200)
        .expect((res: any) => {
          // URL path /v1/ overrides the 2.0.0 → v2 mapping
          if (res.body.version !== "v1")
            throw new Error(`URL /v1/ should override X-App-Version, got ${res.body.version}`);
        })
        .end(done);
    });
  });

  // -------------------------------------------------------------------------
  // Feature flags per API version
  // -------------------------------------------------------------------------

  describe("Feature flags per app version", () => {
    it("v1 does not have webhooks or advanced-filters", () => {
      expect(supportsFeature("v1", "webhooks")).toBe(false);
      expect(supportsFeature("v1", "advanced-filters")).toBe(false);
    });

    it("v2 has webhooks and advanced-filters", () => {
      expect(supportsFeature("v2", "webhooks")).toBe(true);
      expect(supportsFeature("v2", "advanced-filters")).toBe(true);
    });

    it("both v1 and v2 have basic-transactions", () => {
      expect(supportsFeature("v1", "basic-transactions")).toBe(true);
      expect(supportsFeature("v2", "basic-transactions")).toBe(true);
    });

    it("unknown version returns false for any feature", () => {
      expect(supportsFeature("v99", "basic-transactions")).toBe(false);
    });

    it("feature flags are attached to the request object", (done) => {
      request(app)
        .get("/api/v2/test")
        .expect(200)
        .expect((res: any) => {
          const flags = res.body.featureFlags;
          if (!flags) throw new Error("featureFlags not attached to request");
          if (flags["webhooks"] !== true)
            throw new Error("v2 should have webhooks: true");
          if (flags["advanced-filters"] !== true)
            throw new Error("v2 should have advanced-filters: true");
        })
        .end(done);
    });

    it("v1 feature flags disable bulk-compliance", (done) => {
      request(app)
        .get("/api/v1/test")
        .expect(200)
        .expect((res: any) => {
          if (res.body.featureFlags["bulk-compliance"] !== false)
            throw new Error("v1 should have bulk-compliance: false");
        })
        .end(done);
    });

    it("v2 feature flags enable bulk-compliance", (done) => {
      request(app)
        .get("/api/v2/test")
        .expect(200)
        .expect((res: any) => {
          if (res.body.featureFlags["bulk-compliance"] !== true)
            throw new Error("v2 should have bulk-compliance: true");
        })
        .end(done);
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility
  // -------------------------------------------------------------------------

  describe("Backward compatibility layer for old versions", () => {
    it("SUPPORTED_VERSIONS includes both v1 and v2", () => {
      expect(SUPPORTED_VERSIONS).toContain("v1");
      expect(SUPPORTED_VERSIONS).toContain("v2");
    });

    it("CURRENT_VERSION is v1", () => {
      expect(CURRENT_VERSION).toBe("v1");
    });

    it("unversioned API requests still work and get the default version", (done) => {
      request(app)
        .get("/api/test")
        .expect(200)
        .end(done);
    });

    it("returns helpful error message for unsupported versions", (done) => {
      request(app)
        .get("/api/v99/test")
        .expect(400)
        .expect((res: any) => {
          if (!res.body.message) throw new Error("No error message provided");
          if (!res.body.message.includes("v99"))
            throw new Error("Error message should include the bad version");
        })
        .end(done);
    });
  });

  // -------------------------------------------------------------------------
  // Deprecation timeline
  // -------------------------------------------------------------------------

  describe("Deprecation timeline", () => {
    it("getDeprecationTimeline returns an array", () => {
      const timeline = getDeprecationTimeline();
      expect(Array.isArray(timeline)).toBe(true);
    });

    it("deprecated versions have sunsetDate and version fields", () => {
      const timeline = getDeprecationTimeline();
      for (const entry of timeline) {
        expect(entry.version).toBeTruthy();
        expect(entry.sunsetDate).toBeTruthy();
        // sunsetDate should be a parseable ISO date
        expect(new Date(entry.sunsetDate).getTime()).not.toBeNaN();
      }
    });
  });

  // -------------------------------------------------------------------------
  // createVersionedResponse helper
  // -------------------------------------------------------------------------

  describe("createVersionedResponse helper", () => {
    it("wraps data with version and timestamp", () => {
      const response = createVersionedResponse("v1", { foo: "bar" });
      expect(response.version).toBe("v1");
      expect(response.data).toEqual({ foo: "bar" });
      expect(response.meta.timestamp).toBeTruthy();
    });

    it("merges additional meta fields", () => {
      const response = createVersionedResponse("v2", {}, { requestId: "abc" });
      expect(response.meta.requestId).toBe("abc");
    });
  });

  // -------------------------------------------------------------------------
  // Accept-Version header
  // -------------------------------------------------------------------------

  describe("Accept-Version header support", () => {
    it("uses Accept-Version header when no URL version present", (done) => {
      request(app)
        .get("/api/test")
        .set("Accept-Version", "v2")
        .expect(200)
        .expect((res: any) => {
          if (res.body.version !== "v2")
            throw new Error(`Expected v2 from Accept-Version, got ${res.body.version}`);
        })
        .end(done);
    });

    it("normalizes numeric Accept-Version (1 → v1)", (done) => {
      request(app)
        .get("/api/test")
        .set("Accept-Version", "1")
        .expect(200)
        .expect((res: any) => {
          if (res.headers["api-version"] !== "v1")
            throw new Error("Numeric Accept-Version not normalized");
        })
        .end(done);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-version scenario
  // -------------------------------------------------------------------------

  describe("Multi-version scenarios", () => {
    it("handles concurrent requests with different versions independently", async () => {
      const [v1Res, v2Res] = await Promise.all([
        request(app).get("/api/v1/test"),
        request(app).get("/api/v2/test"),
      ]);

      expect(v1Res.body.version).toBe("v1");
      expect(v2Res.body.version).toBe("v2");
    });

    it("v1 and v2 have different feature flag sets", async () => {
      const [v1Res, v2Res] = await Promise.all([
        request(app).get("/api/v1/test"),
        request(app).get("/api/v2/test"),
      ]);

      // v1 webhooks: false, v2 webhooks: true
      expect(v1Res.body.featureFlags.webhooks).toBe(false);
      expect(v2Res.body.featureFlags.webhooks).toBe(true);
    });
  });
});
