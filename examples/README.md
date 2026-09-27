# API integration examples

Working examples for common ProxyPay integrations are provided in three languages:

- `typescript/` uses Node.js 20+ built-in `fetch`, `FormData`, and `crypto`.
- `python/` uses Python 3.10+ standard-library HTTP and HMAC helpers.
- `go/` uses Go 1.21+ standard-library HTTP and HMAC helpers.

Each language demonstrates:

1. Batch imports with CSV upload and job polling.
2. Verifying incoming webhooks with `X-Webhook-Signature`.
3. Creating and pausing a recurring subscription.

## Configuration

Set `PROXYPAY_URL` (default `http://localhost:3000`) and `PROXYPAY_TOKEN` to a JWT from `/api/auth/login`. Set `WEBHOOK_SECRET` when testing webhook verification. The examples do not print tokens or secrets.

## Provider throttling

MTN and Airtel outbound payment, payout, and batch-payout calls are queued in BullMQ and admitted by a Redis-backed token bucket. Configure limits per provider with `MTN_MOMO_TOKENS_PER_SECOND`, `MTN_MOMO_BUCKET_CAPACITY`, `AIRTEL_MOMO_TOKENS_PER_SECOND`, and `AIRTEL_MOMO_BUCKET_CAPACITY`. Set `PROVIDER_THROTTLE_CONCURRENCY` for worker concurrency. Throttling is enabled by default outside tests; set `PROVIDER_THROTTLING_ENABLED=false` only for controlled local use.

The batch endpoint expects CSV columns `amount,phoneNumber,provider,stellarAddress`. Provider values are `MTN`, `AIRTEL`, or `ORANGE`.

## Run

```bash
npx tsx examples/typescript/api-examples.ts
python examples/python/api_examples.py
cd examples/go && go run .
```

The functions are intentionally small so they can be copied into an application and adapted to its HTTP framework.
