import request from "supertest";
import app from "../src/index";
import { pool } from "../src/config/database";
import { disconnectRedis } from "../src/config/redis";

describe("GET /health/lb", () => {
  afterAll(async () => {
    await pool.end();
    await disconnectRedis();
  });

  it("should return 200 or 503 with detailed status", async () => {
    const response = await request(app).get("/health/lb");
    expect([200, 503]).toContain(response.status);
    expect(response.body).toHaveProperty("status");
    expect(response.body).toHaveProperty("checks");
    expect(response.body.checks).toHaveProperty("database");
    expect(response.body.checks).toHaveProperty("redis");
    expect(response.body.checks).toHaveProperty("memory");
  });
});
