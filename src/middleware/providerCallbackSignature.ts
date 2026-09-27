import { createHmac, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { getConfigValue } from "../config/appConfig";
import { getCurrentRequestIp, logSecurityAnomaly } from "../services/logger";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "./errorHandler";
import {
  providerWebhookVerificationTotal,
  providerWebhookVerificationDurationSeconds,
} from "../utils/metrics";

/**
 * Provider webhook authenticity verification.
 *
 * Mobile money providers (MTN MoMo, Airtel Money, Orange Money) deliver
 * transaction state changes via HTTP callbacks. These callbacks mutate
 * internal transaction state, so they MUST be authenticated before being
 * trusted. This module implements a shared, provider-specific HMAC
 * signature verification framework so no provider callback is processed
 * without cryptographic proof of origin.
 *
 * Each provider gets a `ProviderCallbackConfig` describing:
 *  - which config keys hold the shared secret and signature header name
 *  - which signature header(s) to read
 *  - which HMAC algorithms and encodings to accept
 *
 * Failures are surfaced through three monitoring channels:
 *   1. Prometheus counters/histograms (see `src/utils/metrics.ts`)
 *   2. Security anomaly audit log (`logSecurityAnomaly`)
 *   3. HTTP 401/500 responses so the provider can retry/repair
 */

export type WebhookSignatureAlgorithm = "sha256" | "sha1";
export type WebhookSignatureEncoding = "hex" | "base64";

export interface ProviderCallbackConfig {
  /** Provider identifier used in metrics and anomaly logs (e.g. "mtn"). */
  provider: string;
  /** Convict config key holding the HMAC shared secret. */
  secretConfigKey: string;
  /** Convict config key holding the signature header name. */
  headerConfigKey: string;
  /** Header used when none is configured (lowercase). */
  defaultHeader: string;
  /** Additional headers accepted as fallbacks (lowercase). */
  altHeaders?: string[];
  /** HMAC algorithms tried in order. Defaults to ["sha256"]. */
  algorithms?: WebhookSignatureAlgorithm[];
  /** Accept Stripe-style "sha256=<hex>" prefixed signatures. Defaults to true. */
  allowPrefixed?: boolean;
  /** Encoding used when the signature has no algorithm prefix. Defaults to "base64". */
  defaultEncoding?: WebhookSignatureEncoding;
}

export const DEFAULT_CALLBACK_CONFIG: Omit<
  ProviderCallbackConfig,
  "provider" | "secretConfigKey" | "headerConfigKey" | "defaultHeader"
> = {
  altHeaders: [],
  algorithms: ["sha256"],
  allowPrefixed: true,
  defaultEncoding: "base64",
};

// ---------------------------------------------------------------------------
// Pure verification helpers (exported for unit testing)
// ---------------------------------------------------------------------------

function normalizeEncoding(encoding: WebhookSignatureEncoding) {
  return encoding;
}

/**
 * Compute the expected HMAC digest for `payload` using `secret`.
 * Returns the digest encoded as `encoding` (hex or base64).
 */
export function computeExpectedSignature(
  payload: Buffer,
  secret: string,
  algorithm: WebhookSignatureAlgorithm,
  encoding: WebhookSignatureEncoding,
): string {
  const digest = createHmac(algorithm, secret).update(payload).digest();
  if (normalizeEncoding(encoding) === "hex") {
    return digest.toString("hex");
  }
  return digest.toString("base64");
}

/**
 * Constant-time string comparison. Length mismatch fails fast (safe — both
 * values are attacker-influenced only in the incoming half, and a length
 * check cannot leak secret material).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Verify an incoming provider signature against the raw request body.
 *
 * Supported forms (tried in order):
 *   1. Prefixed hex, e.g. `sha256=deadbeef...` (HMAC-SHA256 hex digest).
 *   2. Raw digest using the provider's default encoding (base64 by default),
 *      tried against every configured algorithm.
 *
 * @param payload     The exact raw request body used to build the signature.
 * @param signature   The signature value received in the webhook header.
 * @param secret      The provider-specific shared HMAC secret.
 * @param options     Provider verification options (algorithms, encodings).
 */
export function verifyProviderSignature(
  payload: Buffer,
  signature: string,
  secret: string,
  options: Pick<
    ProviderCallbackConfig,
    "algorithms" | "allowPrefixed" | "defaultEncoding"
  > = DEFAULT_CALLBACK_CONFIG,
): boolean {
  const algorithms = options.algorithms ?? ["sha256"];
  const allowPrefixed = options.allowPrefixed ?? true;
  const defaultEncoding = options.defaultEncoding ?? "base64";

  const trimmed = signature.trim();
  if (!trimmed) return false;

  // 1. Prefixed hex form: sha256=<hex>
  if (allowPrefixed) {
    const prefixMatch = /^sha(?:256|1)=([0-9a-fA-F]+)$/.exec(trimmed);
    if (prefixMatch) {
      const algorithm = trimmed.startsWith("sha1=") ? "sha1" : "sha256";
      const expected = computeExpectedSignature(payload, secret, algorithm, "hex");
      return safeEqual(prefixMatch[1].toLowerCase(), expected.toLowerCase());
    }
  }

  // 2. Raw digest form — try default encoding first, then the alternative.
  const encodings: WebhookSignatureEncoding[] =
    defaultEncoding === "hex" ? ["hex", "base64"] : ["base64", "hex"];

  for (const algorithm of algorithms) {
    for (const encoding of encodings) {
      const expected = computeExpectedSignature(payload, secret, algorithm, encoding);
      if (safeEqual(trimmed, expected)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Express middleware factory
// ---------------------------------------------------------------------------

export interface ProviderSignatureFailure {
  reason:
    | "callback_secret_not_configured"
    | "callback_signature_missing"
    | "callback_signature_invalid"
    | "callback_signature_error";
  headerPresent: boolean;
}

export function buildFailureEvent(
  req: Request,
  provider: string,
  failure: ProviderSignatureFailure,
): void {
  logSecurityAnomaly({
    event: "security.anomaly",
    timestamp: new Date().toISOString(),
    path: req.originalUrl || req.url,
    method: req.method,
    ip: getCurrentRequestIp(req),
    reason: failure.reason,
    provider,
    headerPresent: failure.headerPresent,
  });
}

export function recordVerificationMetric(
  provider: string,
  outcome: "valid" | "invalid",
  reason: string,
): void {
  providerWebhookVerificationTotal.inc({ provider, outcome, reason }, 1);
}

function resolveHeaderName(
  req: Request,
  config: ProviderCallbackConfig,
): string {
  const configured = getConfigValue(config.headerConfigKey);
  const headerName =
    String(configured ?? "").trim().toLowerCase() || config.defaultHeader;
  return headerName;
}

function readSignature(req: Request, config: ProviderCallbackConfig): string | undefined {
  const headerName = resolveHeaderName(req, config);
  const headerValue = req.headers[headerName] as string | undefined;
  if (headerValue) return headerValue;

  for (const alt of config.altHeaders ?? []) {
    const altValue = req.headers[alt] as string | undefined;
    if (altValue) return altValue;
  }

  return undefined;
}

function getRawPayload(req: Request): Buffer {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  return rawBody || Buffer.from(JSON.stringify(req.body || {}));
}

/**
 * Create an Express middleware that verifies the authenticity of incoming
 * provider webhooks before any downstream handler runs.
 *
 * Behavior mirrors the original MTN middleware semantics:
 *  - Missing shared secret            → 500 (misconfiguration, provider cannot verify)
 *  - Missing / invalid signature      → 401 (rejected, monitored)
 *  - Valid signature                  → next()
 */
export function createProviderCallbackVerifier(
  config: ProviderCallbackConfig,
) {
  return function verifyProviderCallback(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const startedAt = process.hrtime.bigint();
    const provider = config.provider;

    const finish = (outcome: "valid" | "invalid", reason: string) => {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1e9;
      providerWebhookVerificationDurationSeconds.observe(
        { provider, outcome },
        durationSeconds,
      );
      recordVerificationMetric(provider, outcome, reason);
    };

    const callbackSecret = String(
      getConfigValue(config.secretConfigKey) ?? "",
    ).trim();

    if (!callbackSecret) {
      buildFailureEvent(req, provider, {
        reason: "callback_secret_not_configured",
        headerPresent: false,
      });
      finish("invalid", "callback_secret_not_configured");
      res
        .status(500)
        .json({ error: `${provider} callback verification not configured` });
      return;
    }

    const signature = readSignature(req, config);
    if (!signature) {
      buildFailureEvent(req, provider, {
        reason: "callback_signature_missing",
        headerPresent: false,
      });
      finish("invalid", "callback_signature_missing");
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
        error: "Unauthorized callback",
      });
    }

    const payload = getRawPayload(req);

    try {
      const valid = verifyProviderSignature(payload, signature, callbackSecret, {
        algorithms: config.algorithms,
        allowPrefixed: config.allowPrefixed,
        defaultEncoding: config.defaultEncoding,
      });

      if (!valid) {
        buildFailureEvent(req, provider, {
          reason: "callback_signature_invalid",
          headerPresent: true,
        });
        finish("invalid", "callback_signature_invalid");
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
          error: "Unauthorized callback",
        });
      }

      finish("valid", "signature_verified");
      next();
    } catch (error) {
      if (error && (error as any).code) throw error;
      buildFailureEvent(req, provider, {
        reason: "callback_signature_error",
        headerPresent: true,
      });
      finish("invalid", "callback_signature_error");
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized callback", {
        error: "Unauthorized callback",
      });
    }
  };
}
