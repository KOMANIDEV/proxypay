import { jest } from "@jest/globals";
import { createHmac } from "crypto";

jest.mock("../../src/config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.mtn.callbackSecret") return "mtn-secret";
    if (key === "providers.airtel.callbackSecret") return "airtel-secret";
    if (key === "providers.orange.callbackSecret") return "orange-secret";
    if (key === "providers.mtn.callbackSignatureHeader")
      return "x-callback-signature";
    if (key === "providers.airtel.callbackSignatureHeader")
      return "x-airtel-signature";
    if (key === "providers.orange.callbackSignatureHeader")
      return "x-orange-signature";
    return undefined;
  }),
}));

import express from "express";
import supertest from "supertest";
import { errorHandler } from "../../src/middleware/errorHandler";
import {
  verifyProviderSignature,
  computeExpectedSignature,
} from "../../src/middleware/providerCallbackSignature";
import mtnCallbacksRouter from "../../src/routes/mtnCallbacks";
import airtelCallbacksRouter from "../../src/routes/airtelCallbacks";
import orangeCallbacksRouter from "../../src/routes/orangeCallbacks";

function hmacBase64(payload: string, secret: string, algo = "sha256"): string {
  return createHmac(algo, secret).update(payload).digest("base64");
}

function hmacHex(payload: string, secret: string, algo = "sha256"): string {
  return createHmac(algo, secret).update(payload).digest("hex");
}

describe("verifyProviderSignature (pure logic)", () => {
  const payload = Buffer.from(JSON.stringify({ status: "completed", amount: "100" }));

  it("accepts a valid base64 HMAC-SHA256 signature", () => {
    const signature = hmacBase64(payload.toString(), "secret");
    expect(verifyProviderSignature(payload, signature, "secret")).toBe(true);
  });

  it("accepts a prefixed hex signature (sha256=<hex>)", () => {
    const signature = `sha256=${hmacHex(payload.toString(), "secret")}`;
    expect(verifyProviderSignature(payload, signature, "secret")).toBe(true);
  });

  it("accepts a prefixed sha1 signature when sha1 is allowed", () => {
    const signature = `sha1=${hmacHex(payload.toString(), "secret", "sha1")}`;
    expect(
      verifyProviderSignature(payload, signature, "secret", {
        algorithms: ["sha1", "sha256"],
      }),
    ).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const signature = hmacBase64(payload.toString(), "secret");
    const tampered = Buffer.from(JSON.stringify({ status: "failed", amount: "999" }));
    expect(verifyProviderSignature(tampered, signature, "secret")).toBe(false);
  });

  it("rejects a signature computed with a different secret", () => {
    const signature = hmacBase64(payload.toString(), "wrong-secret");
    expect(verifyProviderSignature(payload, signature, "secret")).toBe(false);
  });

  it("rejects empty and malformed signatures", () => {
    expect(verifyProviderSignature(payload, "", "secret")).toBe(false);
    expect(verifyProviderSignature(payload, "garbage", "secret")).toBe(false);
    expect(verifyProviderSignature(payload, "sha256=zzzz", "secret")).toBe(false);
  });

  it("computes matching digests in hex and base64", () => {
    const hex = computeExpectedSignature(payload, "secret", "sha256", "hex");
    const b64 = computeExpectedSignature(payload, "secret", "sha256", "base64");
    expect(hex).toBe(hmacHex(payload.toString(), "secret"));
    expect(b64).toBe(hmacBase64(payload.toString(), "secret"));
  });
});

describe("Provider callback routes — signature enforcement", () => {
  const routers: Array<{
    path: string;
    router: express.Router;
    secret: string;
    header: string;
  }> = [
    {
      path: "/api/mtn",
      router: mtnCallbacksRouter,
      secret: "mtn-secret",
      header: "X-Callback-Signature",
    },
    {
      path: "/api/airtel",
      router: airtelCallbacksRouter,
      secret: "airtel-secret",
      header: "X-Airtel-Signature",
    },
    {
      path: "/api/orange",
      router: orangeCallbacksRouter,
      secret: "orange-secret",
      header: "X-Orange-Signature",
    },
  ];

  routers.forEach(({ path, router, secret, header }) => {
    const provider = path.replace("/api/", "");
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(
        express.json({
          verify: (req, _res, buf) => {
            (req as any).rawBody = buf;
          },
        }),
      );
      app.use(path, router);
      app.use(errorHandler);
    });

    it(`${provider}: accepts a valid signed callback`, async () => {
      const payload = { status: "completed", transactionId: "txn-1" };
      const body = JSON.stringify(payload);
      const signature = hmacBase64(body, secret);

      const res = await supertest(app)
        .post(`${path}/callback`)
        .set(header, signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "accepted" });
    });

    it(`${provider}: rejects a callback with a missing signature`, async () => {
      const res = await supertest(app)
        .post(`${path}/callback`)
        .send({ status: "completed" });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: "Unauthorized callback",
        code: "UNAUTHORIZED",
        statusCode: 401,
      });
    });

    it(`${provider}: rejects a callback with an invalid signature`, async () => {
      const res = await supertest(app)
        .post(`${path}/callback`)
        .set(header, "not-a-valid-signature")
        .send({ status: "completed" });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: "Unauthorized callback",
        code: "UNAUTHORIZED",
        statusCode: 401,
      });
    });

    it(`${provider}: rejects a callback signed for a different payload`, async () => {
      const payload = { status: "completed" };
      const body = JSON.stringify(payload);
      const signature = hmacBase64(body, secret);

      const res = await supertest(app)
        .post(`${path}/callback`)
        .set(header, signature)
        .send({ status: "failed" }); // different body than what was signed

      expect(res.status).toBe(401);
    });
  });

  it("mtn: accepts a prefixed hex signature", async () => {
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as any).rawBody = buf;
        },
      }),
    );
    app.use("/api/mtn", mtnCallbacksRouter);
    app.use(errorHandler);

    const payload = { status: "incoming", amount: "100" };
    const body = JSON.stringify(payload);
    const signature = `sha256=${hmacHex(body, "mtn-secret")}`;

    const res = await supertest(app)
      .post("/api/mtn/callback")
      .set("X-Callback-Signature", signature)
      .send(payload);

    expect(res.status).toBe(200);
  });
});
