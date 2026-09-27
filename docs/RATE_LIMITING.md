# API Rate Limiting Guide

This document describes the rate limiting architecture, policies, response headers, and client integration patterns for the ProxyPay API.

---

## 1. Overview & Tiered Limits

ProxyPay implements sliding-window and token-bucket rate limiting to ensure fair usage, prevent denial-of-service, and maintain service availability. Limits are enforced per IP address for unauthenticated traffic and per API key / merchant ID for authenticated traffic.

| Endpoint Category | Public (Unauthenticated) | Authenticated Merchant | Admin / System |
| :--- | :--- | :--- | :--- |
| **Authentication & Tokens** (`/api/v1/auth/*`) | 10 req / min | 30 req / min | 120 req / min |
| **Transactions - Reads** (`GET /api/v1/transactions/*`) | 60 req / min | 300 req / min | 1200 req / min |
| **Transactions - Writes** (`POST /api/v1/transactions/*`) | 20 req / min | 120 req / min | 600 req / min |
| **SEP-6 & SEP-12 Endpoints** (`/sep6/*`, `/sep12/*`) | 30 req / min | 150 req / min | 600 req / min |
| **Public Information** (`GET /health`, `/info`) | 120 req / min | 600 req / min | Unlimited |

---

## 2. Rate Limit Headers

Every API response includes standardized HTTP headers indicating the current quota status:

- `X-RateLimit-Limit`: Maximum number of allowed requests in the current window.
- `X-RateLimit-Remaining`: Number of remaining requests permitted within the current window.
- `X-RateLimit-Reset`: Unix epoch timestamp (in seconds) when the current window resets.
- `Retry-After`: Included on `429 Too Many Requests` responses; specifies the number of seconds to wait before retrying.

---

## 3. Error Response Format (HTTP 429)

When a client exceeds the allocated rate limit, the API responds with `HTTP 429 Too Many Requests`:

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Please retry after 15 seconds.",
  "statusCode": 429,
  "retryAfter": 15,
  "code": "RATE_LIMIT_EXCEEDED"
}
```

---

## 4. Client Integration & Retry Handling

### Node.js / TypeScript Example (Exponential Backoff with Jitter)

```typescript
import axios, { AxiosError } from "axios";

async function makeRequestWithRetry(url: string, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios.get(url);
    } catch (err: any) {
      if (err.response?.status === 429 && attempt < maxRetries) {
        const retryAfterSeconds = parseInt(err.response.headers["retry-after"] || "1", 10);
        const jitter = Math.random() * 200;
        const delayMs = (retryAfterSeconds * 1000) + jitter;
        console.warn(`[RateLimit] 429 received. Backing off for ${delayMs}ms (attempt ${attempt + 1})`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}
```

### Python Example

```python
import time
import random
import requests

def call_api_with_backoff(url, headers, max_retries=3):
    for attempt in range(max_retries + 1):
        resp = requests.get(url, headers=headers)
        if resp.status_code == 429 and attempt < max_retries:
            retry_after = int(resp.headers.get("Retry-After", 2))
            jitter = random.uniform(0.1, 0.5)
            time.sleep(retry_after + jitter)
            continue
        return resp
```
