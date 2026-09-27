import express from "express";
import request from "supertest";
import { requestLogger } from "../logger";
import logger from "../../utils/logger";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn() },
  childLogger: jest.fn(() => ({ info: jest.fn() })),
}));

const mockLoggerInfo = logger.info as jest.Mock;

describe("requestLogger", () => {
  beforeEach(() => {
    mockLoggerInfo.mockClear();
  });

  it("logs request and response details with sensitive fields redacted", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { id: string }).id = "request-123";
      next();
    });
    app.use(requestLogger);
    app.post("/api/payments", (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.status(201).json({ created: true });
    });

    await request(app)
      .post("/api/payments?token=do-not-log&region=west")
      .set("user-agent", "Mozilla/5.0")
      .send({ amount: 100, password: "do-not-log" });

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const entry = mockLoggerInfo.mock.calls[0][0];
    expect(entry).toEqual(
      expect.objectContaining({
        event: { dataset: "http.request" },
        requestId: "request-123",
        method: "POST",
        path: "/api/payments",
        statusCode: 201,
        query: { token: "[REDACTED]", region: "west" },
        requestBody: { amount: 100, password: "[REDACTED]" },
        http: expect.objectContaining({
          response: expect.objectContaining({
            status_code: 201,
            content_type: expect.stringContaining("application/json"),
          }),
        }),
      }),
    );
    expect(entry.responseTimeMs).toEqual(expect.any(Number));
  });

  it("logs a request only once when the response closes", () => {
    const app = express();
    app.use(requestLogger);
    app.get("/api/close", (_req, res) => res.end());

    return request(app)
      .get("/api/close")
      .then(() => {
        expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      });
  });
});
