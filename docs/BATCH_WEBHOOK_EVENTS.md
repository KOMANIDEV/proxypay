# Merchant Webhook Batch Events (Issue #626)

## Problem

Merchant webhooks only emitted transaction-level events
(`transaction.completed`, `transaction.failed`, `transaction.pending`,
`transaction.cancelled`). Batch operations (bulk payouts) reported nothing, so
merchant portals could not track batch progress, completion summaries or
failures.

## Events

| Event             | When it is emitted                                            | Payload highlights                                                                     |
| ----------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `batch_started`   | A batch operation record is created and moved to `processing` | `batchId`, `batchReference`, `provider`, `operationType`, `totalItems`, `pendingItems` |
| `batch_completed` | All batch items have been processed                           | everything above plus `summary`                                                        |
| `batch_failed`    | The provider call for the batch threw                         | everything above plus `error`                                                          |

`summary` is:

```json
{
  "totalItems": 10,
  "completedItems": 8,
  "failedItems": 1,
  "pendingItems": 1,
  "successRate": 0.8,
  "durationMs": 5000
}
```

Every payload also carries the `event` name and an ISO `timestamp`, so a single
merchant endpoint can distinguish batch from transaction deliveries.

## Where they are triggered

`src/queue/batchPayoutWorker.ts`:

- `batch_started` — immediately after `BatchOperationModel.updateStatus(..., Processing)`
- `batch_completed` — after `processBatchResults()` finishes
- `batch_failed` — when `MobileMoneyService.sendBatchPayout` throws; the batch
  operation is also marked `failed`

Delivery is handled by `BatchWebhookService` in
`src/services/batchWebhookService.ts`.

## Configuration / filtering

Merchants opt in per webhook through the `events` array
(`POST /api/webhooks` / `PATCH /api/webhooks/:id`). `batch_started`,
`batch_completed` and `batch_failed` are now valid values.

Globally, the `BATCH_WEBHOOK_EVENTS` environment variable acts as an allow-list:

```bash
# deliver every batch event (default when unset)
BATCH_WEBHOOK_EVENTS=

# only deliver completion and failure events
BATCH_WEBHOOK_EVENTS=batch_completed,batch_failed
```

Events that are filtered out return `{ success: true, skipped: true }` and are
not sent. Unknown names in the allow-list are ignored.

## Backwards compatibility

`sendBatchProgressWebhook`, `sendBatchCompletionWebhook` and
`sendBatchFailureWebhook` are retained as deprecated aliases of
`sendBatchCompletedWebhook` / `sendBatchFailedWebhook`.

## Tests

`tests/services/batchWebhookService.events.test.ts` covers delivery of all three
events, the summary payload, error details, filter behaviour, missing webhook
URLs, retry exhaustion and the `BATCH_WEBHOOK_EVENTS` parser.
