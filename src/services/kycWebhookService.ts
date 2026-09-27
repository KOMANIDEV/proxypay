/**
 * #402 – KYC Document Verification Status Callbacks
 *
 * Implements a webhook callback system for KYC status changes:
 *  - Webhook event schema (KYCWebhookEvent)
 *  - Persistent delivery log stored in kyc_webhook_deliveries
 *  - Retry logic with exponential back-off (up to MAX_ATTEMPTS)
 *  - Test-fire endpoint helper
 */

import crypto from "crypto";
import { pool } from "../config/database";

// ─── Event schema ─────────────────────────────────────────────────────────────

export type KYCEventType =
  | "kyc.check.completed"
  | "kyc.check.initiated"
  | "kyc.document.uploaded"
  | "kyc.applicant.created"
  | "kyc.workflow.completed"
  | "kyc.status.changed";

export type KYCStatus = "approved" | "rejected" | "pending" | "review";

export interface KYCWebhookEvent {
  id: string;
  type: KYCEventType;
  created_at: string;
  api_version: string;
  data: {
    object_id: string;
    object_type: "applicant" | "check" | "document" | "workflow_run";
    applicant_id: string;
    status: KYCStatus;
    previous_status?: KYCStatus;
    kyc_level?: string;
    rejection_reasons?: string[];
    metadata?: Record<string, unknown>;
  };
}

// ─── Delivery record ─────────────────────────────────────────────────────────

export interface KYCWebhookDelivery {
  id: string;
  user_id: string;
  event_type: KYCEventType;
  event_id: string;
  payload: KYCWebhookEvent;
  target_url: string;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  status: "pending" | "delivered" | "failed" | "exhausted";
  http_status?: number;
  error_message?: string;
  created_at: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
const WEBHOOK_SECRET = process.env.KYC_WEBHOOK_SECRET || "kyc-webhook-dev-secret";
const KYC_WEBHOOK_API_VERSION = "2026-08-01";

/** Back-off delays in milliseconds for each retry attempt (1-indexed). */
function backoffMs(attempt: number): number {
  // 30s, 2m, 10m, 30m, 2h
  const delays = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
  return delays[Math.min(attempt - 1, delays.length - 1)];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function buildKYCWebhookEvent(
  type: KYCEventType,
  data: KYCWebhookEvent["data"],
): KYCWebhookEvent {
  return {
    id: `kyc_evt_${crypto.randomUUID()}`,
    type,
    created_at: new Date().toISOString(),
    api_version: KYC_WEBHOOK_API_VERSION,
    data,
  };
}

export function signWebhookPayload(payload: string, secret: string = WEBHOOK_SECRET): string {
  const ts = Math.floor(Date.now() / 1000);
  const signed = `${ts}.${payload}`;
  const hmac = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${ts},v1=${hmac}`;
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string = WEBHOOK_SECRET,
  toleranceSeconds = 300,
): boolean {
  try {
    const parts = Object.fromEntries(
      signature.split(",").map((p) => p.split("=")),
    ) as Record<string, string>;

    const ts = parseInt(parts["t"] ?? "0", 10);
    if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

    const signed = `${ts}.${rawBody}`;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(signed)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(parts["v1"] ?? "", "hex"),
    );
  } catch {
    return false;
  }
}

// ─── Database helpers ─────────────────────────────────────────────────────────

export async function enqueueKYCWebhook(
  userId: string,
  targetUrl: string,
  event: KYCWebhookEvent,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO kyc_webhook_deliveries
       (user_id, event_type, event_id, payload, target_url, status, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
     RETURNING id`,
    [userId, event.type, event.id, JSON.stringify(event), targetUrl],
  );
  return rows[0].id;
}

export async function getPendingKYCWebhooks(): Promise<KYCWebhookDelivery[]> {
  const { rows } = await pool.query<KYCWebhookDelivery>(
    `SELECT * FROM kyc_webhook_deliveries
     WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
     ORDER BY created_at
     LIMIT 50`,
  );
  return rows;
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

export async function deliverKYCWebhook(
  delivery: KYCWebhookDelivery,
): Promise<void> {
  const payloadStr = JSON.stringify(delivery.payload);
  const signature = signWebhookPayload(payloadStr);

  let httpStatus: number | undefined;
  let errorMessage: string | undefined;
  let success = false;

  try {
    const res = await fetch(delivery.target_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-KYC-Signature": signature,
        "X-KYC-Event-Type": delivery.event_type,
        "X-KYC-Event-Id": delivery.event_id,
        "X-KYC-Api-Version": KYC_WEBHOOK_API_VERSION,
      },
      body: payloadStr,
      signal: AbortSignal.timeout(10_000),
    });

    httpStatus = res.status;
    success = res.ok;
    if (!success) {
      errorMessage = `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const newAttemptCount = delivery.attempt_count + 1;
  const exhausted = newAttemptCount >= MAX_ATTEMPTS;
  const newStatus = success
    ? "delivered"
    : exhausted
      ? "exhausted"
      : "pending";

  const nextAttemptAt =
    !success && !exhausted
      ? new Date(Date.now() + backoffMs(newAttemptCount)).toISOString()
      : null;

  await pool.query(
    `UPDATE kyc_webhook_deliveries
     SET attempt_count   = $1,
         last_attempt_at = NOW(),
         next_attempt_at = $2,
         status          = $3,
         http_status     = $4,
         error_message   = $5
     WHERE id = $6`,
    [
      newAttemptCount,
      nextAttemptAt,
      newStatus,
      httpStatus ?? null,
      errorMessage ?? null,
      delivery.id,
    ],
  );

  if (!success) {
    console.warn("[kyc-webhook] delivery failed", {
      deliveryId: delivery.id,
      attempt: newAttemptCount,
      status: newStatus,
      error: errorMessage,
    });
  }
}

/**
 * Process all pending webhook deliveries (called by a cron/queue worker).
 */
export async function processKYCWebhookQueue(): Promise<void> {
  const pending = await getPendingKYCWebhooks();
  await Promise.allSettled(pending.map(deliverKYCWebhook));
}

// ─── Dispatch helper ──────────────────────────────────────────────────────────

/**
 * Look up a user's configured webhook URL and enqueue an event.
 * If no webhook URL is configured for the user, this is a no-op.
 */
export async function dispatchKYCStatusEvent(
  userId: string,
  data: KYCWebhookEvent["data"],
  type: KYCEventType = "kyc.status.changed",
): Promise<void> {
  // Find the user's webhook URL from settings
  const { rows } = await pool.query<{ webhook_url: string }>(
    `SELECT webhook_url FROM kyc_webhook_configs WHERE user_id = $1 AND active = TRUE LIMIT 1`,
    [userId],
  );

  if (!rows.length || !rows[0].webhook_url) return;

  const event = buildKYCWebhookEvent(type, data);
  await enqueueKYCWebhook(userId, rows[0].webhook_url, event);
}
