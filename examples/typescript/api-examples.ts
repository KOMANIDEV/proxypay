import { createHmac, timingSafeEqual } from "node:crypto";

const baseUrl = process.env.PROXYPAY_URL ?? "http://localhost:3000";
const token = process.env.PROXYPAY_TOKEN;

function authHeaders(): HeadersInit {
  if (!token) throw new Error("Set PROXYPAY_TOKEN before calling the API");
  return { Authorization: `Bearer ${token}` };
}

export async function uploadBatch(csv: string) {
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "transactions.csv");
  const response = await fetch(`${baseUrl}/api/transactions/bulk`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!response.ok) throw new Error(`Batch upload failed: ${response.status} ${await response.text()}`);
  const job = (await response.json()) as { jobId: string };
  let status: { status: string; progress: { processed: number; total: number } };
  do {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const poll = await fetch(`${baseUrl}/api/transactions/bulk/${job.jobId}/status`);
    if (!poll.ok) throw new Error(`Batch poll failed: ${poll.status}`);
    status = (await poll.json()) as typeof status;
  } while (status.status !== "completed" && status.status !== "failed");
  return { jobId: job.jobId, ...status };
}

export function verifyWebhook(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = Buffer.from(signature.slice(7), "utf8");
  const computed = Buffer.from(expected, "utf8");
  return received.length === computed.length && timingSafeEqual(received, computed);
}

export async function createSubscription() {
  const response = await fetch(`${baseUrl}/api/subscriptions`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ amount: "25.00", currency: "USD", interval: "monthly", phone_number: "+237670000000" }),
  });
  if (!response.ok) throw new Error(`Subscription creation failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { subscription: { id: string; status: string } };
}

export async function pauseSubscription(id: string) {
  const response = await fetch(`${baseUrl}/api/subscriptions/${id}/pause`, { method: "POST", headers: authHeaders() });
  if (!response.ok) throw new Error(`Subscription pause failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ paused: boolean }>;
}

if (process.argv[1]?.endsWith("api-examples.ts")) {
  const result = await uploadBatch("amount,phoneNumber,provider,stellarAddress\n10,+237670000000,MTN,GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF\n");
  console.log(result);
  const subscription = await createSubscription();
  console.log(await pauseSubscription(subscription.subscription.id));
}
