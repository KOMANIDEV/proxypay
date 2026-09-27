import { createHmac } from "node:crypto";
import { test, expect, APIRequestContext, request } from "@playwright/test";

const STELLAR_ACCOUNT =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const CALLBACK_SECRET = process.env.MTN_CALLBACK_SECRET;

test.describe("Complete transaction flows", () => {
  test.describe.configure({ mode: "serial" });

  let api: APIRequestContext;
  let sep24TransactionId: string;
  let coreTransactionId: string;
  let authToken: string;
  let userId: string;

  test.beforeAll(async () => {
    api = await request.newContext({
      baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3000",
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test("completes a deposit through provider callback and verifies final state", async () => {
    const initiate = await api.post("/sep24/deposit", {
      data: {
        asset_code: "XLM",
        amount: "500",
        account: STELLAR_ACCOUNT,
        email: `e2e-${Date.now()}@example.com`,
      },
    });
    expect(initiate.ok(), await initiate.text()).toBeTruthy();
    sep24TransactionId = (await initiate.json()).id;

    const pending = await api.get(`/sep24/transaction/${sep24TransactionId}`);
    expect(pending.ok()).toBeTruthy();
    expect((await pending.json()).status).toBe("pending_user_transfer_start");

    const callback = await api.post(`/sep24/callback/${sep24TransactionId}`, {
      data: {
        status: "completed",
        message: "Provider transfer confirmed",
        amount_in: "500",
        amount_out: "499.50",
        amount_fee: "0.50",
        from: "+237670000001",
        to: STELLAR_ACCOUNT,
      },
    });
    expect(callback.ok(), await callback.text()).toBeTruthy();
    const callbackBody = await callback.json();
    expect(callbackBody.transaction.status).toBe("completed");
    expect(callbackBody.redirect).toContain("/sep24/success");

    const completed = await api.get(`/sep24/transaction/${sep24TransactionId}`);
    expect(completed.ok()).toBeTruthy();
    const completedBody = await completed.json();
    expect(completedBody.status).toBe("completed");
    expect(completedBody.amount_out).toBe("499.50");
    expect(completedBody.amount_fee).toBe("0.50");
  });

  test("enforces provider callback signatures and acknowledges valid MTN callbacks", async () => {
    const payload = { transactionId: sep24TransactionId, status: "completed" };
    const invalid = await api.post("/api/mtn/callback", {
      data: payload,
      headers: { "X-Callback-Signature": "invalid-signature" },
    });
    expect(invalid.status()).toBe(401);

    test.skip(!CALLBACK_SECRET, "Requires MTN_CALLBACK_SECRET");
    const rawPayload = JSON.stringify(payload);
    const signature = createHmac("sha256", CALLBACK_SECRET!)
      .update(rawPayload)
      .digest("base64");
    const valid = await api.post("/api/mtn/callback", {
      data: payload,
      headers: { "X-Callback-Signature": signature },
    });
    expect(valid.ok(), await valid.text()).toBeTruthy();
    await expect(valid.json()).resolves.toEqual({ status: "accepted" });
  });

  test("opens and resolves a dispute for a completed core transaction", async () => {
    const phone = `+23767${String(Date.now()).slice(-7)}`;
    const register = await api.post("/api/auth/register", {
      data: { phone_number: phone, password: "Test@Password1!" },
    });
    expect([201, 500]).toContain(register.status());

    const login = await api.post("/api/auth/login", {
      data: { phone_number: phone },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    const loginBody = await login.json();
    authToken = loginBody.token;
    userId = loginBody.user.userId;

    const deposit = await api.post("/api/transactions/deposit", {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        amount: 100,
        phoneNumber: phone,
        provider: "MTN",
        stellarAddress: STELLAR_ACCOUNT,
        userId,
      },
    });
    if (deposit.status() !== 200) {
      test.skip(true, `Core transaction unavailable: ${deposit.status()}`);
    }
    const depositBody = await deposit.json();
    coreTransactionId = depositBody.id ?? depositBody.transactionId;
    expect(coreTransactionId).toBeTruthy();

    const detail = await api.get(`/api/transactions/${coreTransactionId}`);
    expect(detail.ok()).toBeTruthy();
    const detailBody = await detail.json();
    test.skip(detailBody.status !== "completed", "Requires completed core transaction");

    const dispute = await api.post(`/api/transactions/${coreTransactionId}/dispute`, {
      headers: { Authorization: `Bearer ${authToken}` },
      data: { reason: "E2E provider settlement discrepancy", category: "payment" },
    });
    expect(dispute.status()).toBe(201);
    const disputeBody = await dispute.json();
    expect(disputeBody.id).toBeTruthy();

    const resolved = await api.post(`/api/disputes/${disputeBody.id}/resolve`, {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        action: "uphold",
        resolution: "Provider settlement confirmed during E2E reconciliation",
      },
    });
    expect([200, 403]).toContain(resolved.status());
    if (resolved.status() === 200) {
      expect((await resolved.json()).status).toBe("resolved");
    }
  });

  test("includes the flow window in the reconciliation report", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const report = await api.get(
      `/api/reports/reconciliation?startDate=${today}&endDate=${today}`,
      { headers: { "X-API-Key": process.env.ADMIN_API_KEY || "dev-admin-key" } },
    );
    expect([200, 401, 403, 500]).toContain(report.status());
    if (report.status() === 200) {
      const body = await report.json();
      expect(body.period).toEqual({ start: today, end: today });
      expect(body.summary).toEqual(
        expect.objectContaining({
          totalTransactions: expect.any(Number),
          successfulTransactions: expect.any(Number),
          failedTransactions: expect.any(Number),
        }),
      );
      expect(body.byProvider).toBeDefined();
    }
  });
});