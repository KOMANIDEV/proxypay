# Webhook Security

Mobile money providers (MTN MoMo, Airtel Money, Orange Money) deliver
transaction state changes to ProxyPay through HTTP callbacks. Because these
callbacks can mutate internal transaction state, **every incoming provider
webhook is authenticated before it is processed**.

This document explains how authenticity is verified, how to configure each
provider, how failures are monitored, and what to do when verification fails.

## Why webhooks must be verified

Without signature verification, an attacker who can reach the callback
endpoint could forge "transaction completed" events, mark failed transfers as
paid, or otherwise corrupt ledger state. HMAC signature verification proves
that a callback was genuinely produced by the provider that shares the secret
with us — the payload has not been tampered with in transit.

## How verification works

All provider callbacks flow through a shared verification framework
(`src/middleware/providerCallbackSignature.ts`) and are enforced by an Express
middleware **before** the route handler runs:

```
Provider ──POST /api/<provider>/callback──▶ ingress rate limiter
        ──with signature header──────────▶ HMAC verification middleware
                                          ├─ valid     → route handler
                                          ├─ invalid   → 401, monitored
                                          └─ misconfig → 500, monitored
```

1. **Ingress rate limiting** (`ingestRateLimiter`) drops floods cheaply before
   any cryptographic work.
2. **Signature extraction** reads the configured header (plus documented
   fallbacks) from the request.
3. **Signature verification** recomputes the HMAC digest of the **raw request
   body** and compares it constant-time against the received signature.
4. **Result routing** — valid signatures continue to the handler; failures are
   rejected with `401 Unauthorized` and recorded through every monitoring
   channel below.

Supported signature forms (per provider):

| Form | Example | Notes |
|------|---------|-------|
| Raw base64 digest | `BdXoQYx2z...` | Default for MTN / Airtel |
| Raw hex digest | `bd5f2c81...` | Default for Orange |
| Prefixed hex | `sha256=bd5f2c81...` | Accepted everywhere |

The framework tries the provider's default encoding first, then the
alternative, across the configured HMAC algorithms (`sha256`, optionally
`sha1`). Comparison always uses `timingSafeEqual` on equal-length inputs.

## Endpoints

| Endpoint | Provider | Middleware |
|----------|----------|------------|
| `POST /api/mtn/callback` | MTN MoMo | `verifyMtnCallbackSignature` |
| `POST /api/airtel/callback` | Airtel Money | Airtel config of `createProviderCallbackVerifier` |
| `POST /api/orange/callback` | Orange Money | Orange config of `createProviderCallbackVerifier` |

All three share the same framework; MTN additionally keeps a thin
provider-specific module (`src/middleware/mtnCallbackSignature.ts`) for
backward compatibility.

## Configuration

Secrets are configured via environment variables (Convict, see
`src/config/appConfig.ts`). **Never commit real secrets.**

| Provider | Secret env var | Signature header env var | Default header |
|----------|----------------|--------------------------|----------------|
| MTN | `MTN_CALLBACK_SECRET` | `MTN_CALLBACK_SIGNATURE_HEADER` | `X-Callback-Signature` |
| Airtel | `AIRTEL_CALLBACK_SECRET` | `AIRTEL_CALLBACK_SIGNATURE_HEADER` | `X-Airtel-Signature` |
| Orange | `ORANGE_CALLBACK_SECRET` | `ORANGE_CALLBACK_SIGNATURE_HEADER` | `X-Orange-Signature` |

Example:

```bash
# .env
MTN_CALLBACK_SECRET=shared-with-mtn-dashboard
AIRTEL_CALLBACK_SECRET=shared-with-airtel-portal
ORANGE_CALLBACK_SECRET=shared-with-orange-portal
```

If a secret is **not configured**, the endpoint responds `500` (and logs a
`callback_secret_not_configured` anomaly) rather than silently accepting
unauthenticated callbacks. Configure secrets in every environment that
receives provider traffic.

> Provider-specific validation notes:
> - **MTN MoMo**: HMAC-SHA256 over the raw body; base64 or `sha256=<hex>`
>   prefixed signatures are accepted. Falls back to `X-MTN-Signature`.
> - **Airtel Money**: HMAC-SHA256 over the raw body; base64 or prefixed hex.
>   Falls back to `X-Signature`.
> - **Orange Money**: HMAC-SHA256 over the raw body; hex encoding by default.
>   No fallback header.
>
> If a provider changes its signing scheme, extend `ProviderCallbackConfig`
> (algorithms, encodings, headers) — the framework is intentionally
> declarative so provider-specific logic stays data, not copy-paste.

## Monitoring invalid webhooks

Every verification attempt is exported to Prometheus at `/metrics`:

| Metric | Type | Labels |
|--------|------|--------|
| `provider_webhook_verification_total` | Counter | `provider`, `outcome` (`valid`/`invalid`), `reason` |
| `provider_webhook_verification_duration_seconds` | Histogram | `provider`, `outcome` |

Failure reasons recorded:

- `callback_secret_not_configured` — missing secret; fix configuration
- `callback_signature_missing` — no signature header; provider misconfigured
  or attacker probing
- `callback_signature_invalid` — signature present but wrong; tampering,
  stale secret, or payload mismatch
- `callback_signature_error` — unexpected error during verification

**Dashboards/alert suggestions:**

- Rate of `provider_webhook_verification_total{outcome="invalid"}` — sustained
  spikes may indicate credential compromise or a broken provider integration.
- `callback_secret_not_configured` with value `1` — operational incident.
- `callback_signature_invalid` bursts from a single provider — rotate the
  secret and re-sync with the provider.

Failures are also written to the security anomaly audit log via
`logSecurityAnomaly` (event `security.anomaly`, reason, provider, IP, path) so
they surface in the existing anomaly monitoring pipeline.

## Testing webhook authenticity

Run the webhook authenticity suite:

```bash
npm test -- tests/middleware/providerCallbackSignature.test.ts
npm test -- src/routes/__tests__/mtnCallbacks.test.ts
```

The suite covers:

- Valid base64 / prefixed-hex signatures are accepted
- Tampered payloads, wrong secrets, empty and malformed signatures are rejected
- Missing and invalid signature headers return `401`
- Every provider route enforces verification identically

## Operational runbook

1. **Sustained 401s from a provider** — verify the shared secret matches the
   provider dashboard, confirm the callback body is forwarded **verbatim**
   (JSON re-serialization breaks signatures — this is why the middleware reads
   the raw body), and confirm the correct header name.
2. **Secret rotation** — update the provider dashboard and the env var, deploy,
   then monitor `provider_webhook_verification_total{outcome="invalid"}` for
   both the old and new windows.
3. **Replay protection** — verification proves authenticity, not freshness.
   Callback handlers must remain idempotent (keyed on the provider reference /
   transaction id) so replayed or duplicated callbacks are safe.

---

# Merchant Outbound Webhooks: Consumer Verification Guide

ProxyPay delivers outbound event notifications (e.g. `transaction.completed`, `onboarding.completed`, `dispute.created`) to merchant webhook endpoints configured in the dashboard.

To ensure authenticity, prevent tampering, and block replay attacks, **merchants must verify the cryptographic signature** on all incoming webhooks before processing the payload.

## 1. Signature Algorithm

ProxyPay signs all webhook payloads using **HMAC-SHA256**:

- **Algorithm**: `HMAC-SHA256` (Hash-based Message Authentication Code with SHA-256)
- **Key**: The merchant webhook secret configured in the ProxyPay dashboard or returned at webhook creation.
- **Data to sign**: The verbatim raw HTTP request body string (UTF-8 encoded).

## 2. Signature Header Format

ProxyPay attaches the computed signature to each webhook request in the following headers:

- **Primary Header**: `X-Webhook-Signature`
- **Compatibility Header**: `X-Signature`

**Format:**
```http
X-Webhook-Signature: sha256=d3b07384d113edec49eaa6238ad5ff00...
X-Signature: sha256=d3b07384d113edec49eaa6238ad5ff00...
```

The value begins with the prefix `sha256=` followed by the 64-character lowercase hexadecimal HMAC-SHA256 digest.

## 3. Step-by-Step Validation Process for Webhook Consumers

1. **Extract the raw body**: Capture the raw, unparsed request payload bytes or UTF-8 string directly from the incoming HTTP request stream **before** JSON parsing. Re-serializing parsed JSON changes whitespace or key ordering and invalidates the signature.
2. **Extract the signature header**: Read the value of `X-Webhook-Signature` (or `X-Signature`).
3. **Compute expected signature**: Calculate `HMAC-SHA256(secret, raw_body)` formatted as `sha256=<hex_digest>`.
4. **Compare constant-time**: Compare the extracted signature against the expected signature using a timing-safe equality function (to prevent side-channel timing attacks).
5. **Accept or Reject**:
   - If signatures match: Return `200 OK` and process the event asynchronously.
   - If signatures do not match: Return `401 Unauthorized` and discard the request.

---

## 4. Consumer Implementation Examples

### Node.js (Express)

```javascript
const express = require('express');
const crypto = require('crypto');

const app = express();
const WEBHOOK_SECRET = process.env.PROXYPAY_WEBHOOK_SECRET;

// Preserve raw body buffer for verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

function verifyWebhook(req) {
  const signatureHeader = req.headers['x-webhook-signature'] || req.headers['x-signature'];
  if (!signatureHeader) return false;

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  const cleanExpected = expectedSignature.replace(/^sha256=/, '');
  const cleanReceived = signatureHeader.replace(/^sha256=/, '');

  if (cleanExpected.length !== cleanReceived.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(cleanExpected, 'hex'),
    Buffer.from(cleanReceived, 'hex')
  );
}

app.post('/webhook', (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send('Invalid signature');
  }

  const event = req.body;
  console.log(`Received verified event: ${event.eventType}`);

  // Process event idempotently...
  res.status(200).json({ received: true });
});
```

### Python (FastAPI / Flask)

```python
import hmac
import hashlib
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()
WEBHOOK_SECRET = b"your_merchant_webhook_secret"

@app.post("/webhook")
async def handle_webhook(request: Request):
    raw_body = await request.body()
    signature_header = request.headers.get("x-webhook-signature") or request.headers.get("x-signature")

    if not signature_header:
        raise HTTPException(status_code=401, detail="Missing signature header")

    received_digest = signature_header.replace("sha256=", "").strip()
    expected_digest = hmac.new(WEBHOOK_SECRET, raw_body, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected_digest, received_digest):
        raise HTTPException(status_code=401, detail="Invalid signature")

    payload = await request.json()
    # Process event payload...
    return {"status": "ok"}
```

### Go

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
)

func webhookHandler(w http.ResponseWriter, r *http.Request) {
	secret := []byte("your_merchant_webhook_secret")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	sigHeader := r.Header.Get("X-Webhook-Signature")
	if sigHeader == "" {
		sigHeader = r.Header.Get("X-Signature")
	}
	receivedDigest := strings.TrimPrefix(sigHeader, "sha256=")

	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	expectedDigest := hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(expectedDigest), []byte(receivedDigest)) {
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	w.WriteHeader(http.StatusOK)
}
```

---

## 5. Security Recommendations for Webhook Receivers

1. **Verify Before Parsing**: Always verify before deserializing untrusted JSON payloads.
2. **Timing-Safe Comparison**: Always use constant-time comparison methods (`crypto.timingSafeEqual`, `hmac.compare_digest`, `hmac.Equal`).
3. **Idempotency**: Treat all event deliveries idempotently using the transaction or event ID.
4. **TLS Only**: Only expose webhook endpoints over HTTPS with valid SSL/TLS certificates.
