import cors from "cors";
import express from "express";
import request from "supertest";

import {
  createCorsOptions,
  DEFAULT_CORS_MAX_AGE,
  getCorsMaxAge,
} from "../../src/config/cors";

describe("CORS preflight caching", () => {
  const originalCorsMaxAge = process.env.CORS_MAX_AGE;

  afterEach(() => {
    if (originalCorsMaxAge === undefined) {
      delete process.env.CORS_MAX_AGE;
    } else {
      process.env.CORS_MAX_AGE = originalCorsMaxAge;
    }
  });

  it("uses the configured CORS max age", () => {
    process.env.CORS_MAX_AGE = "3600";

    expect(createCorsOptions()).toMatchObject({ maxAge: 3600 });
  });

  it("falls back to the default CORS max age for invalid values", () => {
    process.env.CORS_MAX_AGE = "invalid";

    expect(getCorsMaxAge()).toBe(DEFAULT_CORS_MAX_AGE);
  });

  it("adds Access-Control-Max-Age to preflight responses", async () => {
    process.env.CORS_MAX_AGE = "3600";

    const app = express();
    app.use(cors(createCorsOptions()));
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    const response = await request(app)
      .options("/health")
      .set("Origin", "https://example.com")
      .set("Access-Control-Request-Method", "GET");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-max-age"]).toBe("3600");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });
});
