# Provider Throttle Dead-Letter Queue (Issue #625)

## Problem

The mobile-money provider throttle queue (`src/services/mobilemoney/providerThrottle.ts`)
buffers outbound provider calls (payments, payouts, batch payouts) and drains
them through a Redis token bucket. When the queue was saturated the request was
dropped with no record and no recovery path.

## Behaviour after this change

1. **Queue saturation is now bounded.** Before enqueuing, the service compares
   the current queue depth (waiting + active + delayed) against
   `PROVIDER_THROTTLE_MAX_QUEUE_SIZE` (default `1000`).
2. **Dropped requests are dead-lettered.** When the queue is full the request is
   written to the `mobile-money-provider-calls-dlq` queue (same Redis
   connection) with `provider`, `operation`, the full `payload`, `reason`,
   `failedAt` (ISO timestamp) and `attemptsMade`.
3. **Drops are logged with full context.** A structured
   `provider_throttle_dead_letter` error log line is emitted containing the
   timestamp, provider and payload, so the event is visible in stdout/Loki.
4. **Saturation is surfaced to the caller.** `enqueueProviderCall` throws
   `ProviderThrottleQueueFullError` (carrying the `deadLetterId`) instead of
   silently discarding the request.
5. **Exhausted retries are dead-lettered too.** The worker's `failed` handler
   dead-letters a job once `attemptsMade >= opts.attempts`.

## Admin API

All endpoints require an authenticated admin with the `admin:system`
permission.

| Method | Path                                                 | Description                                          |
| ------ | ---------------------------------------------------- | ---------------------------------------------------- |
| `GET`  | `/api/admin/provider-throttle/dlq?limit=50&offset=0` | List dead-lettered calls (max `limit` 500)           |
| `GET`  | `/api/admin/provider-throttle/dlq/count`             | Number of pending DLQ items                          |
| `POST` | `/api/admin/provider-throttle/dlq/replay`            | Replay up to `limit` items (body `{ "limit": 100 }`) |
| `POST` | `/api/admin/provider-throttle/dlq/:id/replay`        | Replay a single item                                 |

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/api/admin/provider-throttle/dlq?limit=20"

curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/api/admin/provider-throttle/dlq/12/replay"
```

Replays bypass the queue-size cap (an operator explicitly asked for the item to
be retried) and remove the entry from the DLQ only after it has been accepted
back onto the throttle queue.

## Configuration

| Variable                           | Default | Description                                            |
| ---------------------------------- | ------- | ------------------------------------------------------ |
| `PROVIDER_THROTTLE_MAX_QUEUE_SIZE` | `1000`  | Pending jobs allowed before requests are dead-lettered |
| `PROVIDER_THROTTLE_JOB_ATTEMPTS`   | `3`     | Attempts before a job is dead-lettered                 |
| `PROVIDER_THROTTLE_CONCURRENCY`    | `10`    | Worker concurrency                                     |

## Tests

`tests/services/mobilemoney/providerThrottleDlq.test.ts` covers saturation
routing, DLQ logging, listing, counting and replay (including the missing-item
path).
