# Advanced Transaction Filtering, Metadata Search, Notification Status & Compliance Training

Covers four related capabilities that make the transaction and operations
surfaces self-service:

| Section | Issue | Summary |
|---|---|---|
| [Advanced filtering](#1-advanced-transaction-filtering-480) | #480 | Nested AND/OR/NOT filter expressions, range filtering, saved filter templates |
| [Metadata search](#2-transaction-metadata-search-477) | #477 | Full-text and faceted search over transaction metadata |
| [Notification status](#3-notification-system-status-479) | #479 | Per-channel delivery health, status endpoint, failure alerting |
| [Compliance training](#4-compliance-training-dashboard-481) | #481 | Training modules, assignments, certification and a compliance dashboard |

---

## 1. Advanced Transaction Filtering (#480)

### Why a filter expression

A flat query string can express "amount > 1000". It cannot express
"amount > 1000 **and** (status = failed **or** provider = momo) **and not**
tagged internal". Operators need that combination constantly, and previously the
only way to get it was for each of them to write their own SQL.

`GET /api/transactions` therefore accepts a `filter` parameter containing a
filter expression tree, which is validated and compiled to parameterised SQL on
the server.

### Filter node types

| Type | Fields | Compiles to |
|---|---|---|
| `and` | `conditions[]` | `(A AND B)` |
| `or` | `conditions[]` | `(A OR B)` |
| `not` | `condition` | `NOT (A)` |
| `range` | `field`, `min?`, `max?` | `col >= $n AND col <= $n` |
| `compare` | `field`, `operator`, `value` | `col <op> $n` |
| `text` | `field`, `operator`, `value` | `col ILIKE $n ESCAPE '\'` |
| `in` | `field`, `values[]` | `col = ANY($n)` |
| `dateRange` | `field`, `start?`, `end?` | `col >= $n AND col <= $n` |
| `exists` | `metadataKey`, `value` | `metadata ? $n` (or `NOT`) |

`compare` operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`.
`text` operators: `contains`, `equals`, `startsWith`, `endsWith`.

### Example

```http
GET /api/transactions?filter={"type":"and","conditions":[
  {"type":"range","field":"amount","min":1000},
  {"type":"or","conditions":[
    {"type":"compare","field":"status","operator":"eq","value":"failed"},
    {"type":"compare","field":"status","operator":"eq","value":"dispute"}
  ]},
  {"type":"not","condition":{"type":"compare","field":"provider","operator":"eq","value":"momo"}}
]}&limit=20
```

### Flat parameters

For the common cases, no expression is needed:

| Parameter | Description |
|---|---|
| `minAmount`, `maxAmount` | Amount range |
| `currency`, `type` | Exact match |
| `statuses` | Comma-separated statuses |
| `referenceNumber` | Exact match |
| `dateField` | `createdAt` (default) or `updatedAt` |
| `startDateTime`, `endDateTime` | ISO 8601 instants bounding `dateField` |
| `templateId` | Apply a saved template by id |

A flat filter and a `filter` expression are combined with `AND`; `filter` takes
precedence where they overlap.

### Filterable fields

`GET /api/transactions/filters/fields` returns the catalogue. Client field names
are resolved through a fixed whitelist, so a field name is never interpolated
into SQL. Unknown fields are rejected with a message listing what is available.

Numeric fields reject non-numeric values, temporal comparisons are cast to
`timestamptz`, and `%` / `_` in text searches are escaped so a search for `50%`
does not match everything.

Only columns that exist on `transactions` are offered. There is no
`completed_at` column, and the fee columns are `fee_amount` / `provider_fee` —
exposing a name that maps to a missing column would compile cleanly and fail
only at execution time.

### Limits

Expressions are capped at **6 levels of nesting** and **100 nodes**. Inverted
ranges (`min > max`) and inverted date ranges are rejected at validation time
rather than returning an empty result set that looks like missing data.

### Saved filter templates

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/transactions/filters` | List templates visible to you (yours, shared, system) |
| `POST` | `/api/transactions/filters` | Create a template |
| `GET` | `/api/transactions/filters/:id` | Fetch one |
| `PATCH` | `/api/transactions/filters/:id` | Update |
| `DELETE` | `/api/transactions/filters/:id` | Delete |
| `POST` | `/api/transactions/filters/:id/apply` | Run the template's filter |
| `GET` | `/api/transactions/filters/export` | Export all templates as JSON |
| `POST` | `/api/transactions/filters/import` | Import a previously exported payload |
| `POST` | `/api/transactions/filters/validate` | Dry-run an expression; returns the SQL and bound parameters |

```http
POST /api/transactions/filters
{
  "name": "Large failed non-momo",
  "description": "Big-ticket failures we handle ourselves",
  "expression": { "type": "and", "conditions": [
    { "type": "range", "field": "amount", "min": 1000 },
    { "type": "compare", "field": "status", "operator": "eq", "value": "failed" }
  ]},
  "isShared": true
}
```

**Export/import**

`GET /api/transactions/filters/export` returns a self-describing payload
(`{ version, exportedAt, templates[] }`) and sets `Content-Disposition` so the
browser downloads it. Import renames on conflict (`My filter` →
`My filter (imported)`) rather than overwriting, because an import must never
clobber filters that are already in use.

System templates cannot be modified or deleted through the API, and a shared
template can only be deleted by its owner.

---

## 2. Transaction Metadata Search (#477)

### Full-text search (existing, improved)

```http
GET /api/transactions/metadata/search?mode=fts&q=mobile+deposit&ranking=bm25
```

Ranks with `ts_rank` / `ts_rank_cd` / BM25 (`ts_rank_cd` normalised by 32) over
the `metadata_tsv` generated column, with a relevance threshold, Redis caching
and quality metrics.

### The nested-value fix

`metadata_tsv` is built by `jsonb_to_text()`. The original implementation used
`jsonb_each_text`, which only sees top-level keys, so a nested value such as

```json
{"customer": {"name": "Ada Lovelace"}}
```

was flattened to the raw JSON text `{"name": "Ada Lovelace"}`. The index then
tokenised JSON punctuation along with the words, which hurt relevance and made
phrase searches unreliable.

Migration `20260907_metadata_nested_search_facets` replaces the function with a
recursive version that walks nested objects and arrays **and includes object
keys**, so `metadata->'customer'->>'name'` is findable by the word `name` as
well as by `Ada` and `Lovelace`. The generated column and its GIN index are
rebuilt to bake the new function in — this rewrites `transactions` once, so run
it in a maintenance window on large tables.

The function is deliberately **not** reverted by the down migration: restoring
the top-level-only version would reinstate the bug.

### Faceted search

```http
GET /api/transactions/metadata/facets?q=deposit&facets=provider,channel,status
```

Returns the result set plus the counts a UI needs to render filter chips:

```json
{
  "data": {
    "data": [ /* matching transactions */ ],
    "total": 10,
    "facets": {
      "provider": [{ "value": "momo", "count": 6, "percentage": 0.6 }],
      "status":   [{ "value": "completed", "count": 10, "percentage": 1 }]
    },
    "keys": [{ "value": "provider", "count": 10, "percentage": 0.71 }],
    "amountDistribution": [
      { "from": null, "to": 50, "count": 0 },
      { "from": 50, "to": 100, "count": 7 }
    ],
    "queryTimeMs": 12
  }
}
```

| Parameter | Description |
|---|---|
| `q` | Free-text term; omit to facet the whole filtered population |
| `facets` | Comma-separated metadata keys (default: `provider,channel,status,currency,source_country,destination_country`) |
| `filters` | Metadata equality filters, e.g. `provider=momo,channel=web` |
| `status`, `limit`, `offset` | Population narrowing and paging |
| `facet_limit` | Values per facet, max 25 |

**Why it is one statement.** The result set, the total, the facet counts, the key
histogram and the amount histogram are computed in a single query over a single
`base` CTE. Computing them independently would allow the counts to disagree with
the results — worse than having no facets at all. The metadata is expanded once
with `jsonb_each_text` and filtered to the requested keys, rather than once per
facet key.

### Key discovery

```http
GET /api/transactions/metadata/keys
```

Returns which metadata keys exist and how often, which is what a "search by
metadata" UI needs before it can offer anything to search on.

### Performance

| Index | Purpose |
|---|---|
| `idx_txn_metadata_fts` (GIN, rebuilt) | Full-text search over the corrected `metadata_tsv` |
| `idx_txn_metadata_path_ops` (GIN, `jsonb_path_ops`) | `@>` containment — smaller and faster than `jsonb_ops` when only containment is used |
| `idx_txn_metadata_keys` (GIN) | Key histograms, index-assisted rather than a scan |
| `idx_txn_meta_facet_*` | Covering indexes for facet counting on the highest-traffic keys |

`v_slow_metadata_searches` reports read volume per metadata index.

There is deliberately no expression index on a numeric cast of a metadata value:
metadata is free-form user JSON, so `metadata->>'amount'` may legitimately hold
`"N/A"`, and the index build would fail on real data. Facet values are read as
text. Likewise the operational view is built on `pg_stat_user_indexes` rather
than `pg_stat_statements`, so the migration does not require an extension.

---

## 3. Notification System Status (#479)

### The problem

The notification router deliberately swallows per-channel errors so one failing
provider cannot stop the others. The cost of that resilience is that a
misconfigured SMTP relay or an expired push credential is indistinguishable from
a healthy system — the API returns success and no message is ever delivered.

### Delivery tracking

`notificationRouter.sendToChannel` now records every attempt. Recording is
best-effort and never throws: a failure to write the tracking row must not turn
a successful send into a failure.

| Table | Contents |
|---|---|
| `notification_deliveries` | One row per (notification, channel) attempt: status, latency, error, user, transaction |
| `notification_channel_health` | Rolling per-channel snapshot: success/failure counts, average latency, last error, last success/failure |

### Status endpoint

```http
GET /api/notifications/status?windowHours=24
```

Returns **503** when any channel is down, so a load balancer or uptime monitor
can act on it without parsing the body. `200` for healthy and degraded.

```json
{
  "status": "degraded",
  "overallSuccessRate": 0.86,
  "failingChannels": ["sms"],
  "channels": [
    {
      "channel": "sms",
      "status": "degraded",
      "attempts": 20, "successCount": 14, "failureCount": 6,
      "successRate": 0.7, "avgDurationMs": 340,
      "lastError": "SMTP relay unreachable", "lastSuccessAt": "…"
    }
  ]
}
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/notifications/status` | Aggregate status (503 when down) |
| `GET` | `/api/notifications/health/channels` | Per-channel health |
| `GET` | `/api/notifications/analytics` | Volume, failure rate, per-channel and per-category breakdown |
| `GET` | `/api/notifications/deliveries` | Recent attempts (authenticated) |
| `POST` | `/api/notifications/health/refresh` | Force a fresh evaluation (authenticated) |

### Health classification

| Success rate | Verdict |
|---|---|
| `>= 0.95` | `healthy` |
| `> 0.5` and `< 0.95` | `degraded` |
| `<= 0.5` | `down` |
| No attempts in the window | `down` |

A channel with no traffic is reported as `down` rather than `healthy`: it is
unproven, and that is exactly the case that surfaces a channel which was never
wired up. The overall verdict follows the worst channel — one `down` channel
means notifications are not fully working.

Thresholds are configurable via `NOTIFICATION_HEALTH_DEGRADED_THRESHOLD`,
`NOTIFICATION_HEALTH_DOWN_THRESHOLD`, `NOTIFICATION_HEALTH_MIN_ATTEMPTS` and
`NOTIFICATION_HEALTH_WINDOW_HOURS`.

### Failure alerting

`notification-health-check` runs every 5 minutes and escalates **on state
transitions only** — re-alerting on every tick would train operators to ignore
the alert. A channel is announced when it degrades and again when it recovers,
never while it stays broken. The first run reports only channels that are
actually unhealthy, so a cold start pages nobody.

### Metrics

`notification_deliveries_total`, `notification_delivery_duration_seconds`,
`notification_channel_health`, `notification_system_up`.

---

## 4. Compliance Training Dashboard (#481)

### Model

```
modules ──< assignments >── users
   │                            │
   └──< completions (attempts) ─┘
              │
              └──< certifications (issued on pass, with expiry)
```

| Table | Purpose |
|---|---|
| `compliance_training_modules` | Curriculum: questions, passing score, validity period, roles |
| `compliance_training_assignments` | Who must take what, by when |
| `compliance_training_completions` | Every attempt, with score and per-question answers |
| `compliance_certifications` | Issued certificates, with expiry and revocation |

Three modules ship with the migration (`AML_FUNDAMENTALS`,
`SANCTIONS_SCREENING`, `DATA_PROTECTION`), seeded with `ON CONFLICT DO NOTHING`
so a customised module is never silently reset.

### Answer keys are never served

`GET /api/compliance/training/modules/:id` returns the questions with
`correctOption` and `explanation` **stripped**. Grading happens server-side on
submit, and the answer key is only disclosed in the post-submission feedback.

### Attempt lifecycle

```http
POST /api/compliance/training/attempts
{ "moduleId": "…", "answers": [{ "questionId": "q1", "selectedOption": 1 }], "timeSpentSecs": 240 }
```

The response carries the score, pass/fail, per-question feedback and — on a
pass — the certificate number and expiry.

The completion and the certificate are written in **one transaction** on a
dedicated client, so a passed attempt can never exist without its certificate.
(`queryWrite()` is not usable for this: each call may land on a different pooled
connection, so a `BEGIN` issued that way would not enclose the statements that
follow it.)

Unanswered questions score zero rather than rejecting the attempt, so a partially
completed attempt is still recorded and still counts as an attempt.

### Dashboard

```http
GET /api/compliance/training/dashboard
```

| Metric | Definition |
|---|---|
| `complianceRate` | Completed assignments ÷ **all** active assignments. A certificate for a module someone was never assigned does not inflate it. |
| `validCertifications` | Currently valid |
| `expiringCertifications` | Expiring within 30 days |
| `expiredCertifications` | Lapsed |
| `byModule[]` | Assigned, completed, overdue, completion rate, average score, expiring |
| `recentCompletions[]` | Last 20 attempts |

`GET /api/compliance/training/certifications?status=expiring` is the full
register; `status` accepts `valid`, `expiring`, `expired`, `revoked`.

`GET /api/compliance/training/me` returns a person's own record. A renewal
supersedes the certificate it replaced: only the newest certificate per module
counts, so a lapsed old certificate does not keep someone marked non-compliant.
`compliant` is true when nothing assigned is overdue and nothing held has lapsed.

### Expiry alerting

`compliance-expiry-alert` runs daily at 08:00 and escalates at two horizons:
within 7 days (lapsing or lapsed) and within 30 days (expiring soon).

### Revocation

```http
POST /api/compliance/training/certifications/:id/revoke
{ "reason": "Policy updated; recertification required" }
```

A reason is required, and the certificate keeps its history.

---

## Migrations

| Migration | Contents |
|---|---|
| `20260905_notification_delivery_tracking` | `notification_deliveries`, `notification_channel_health` |
| `20260906_transaction_filter_templates` | `transaction_filter_templates`, `transaction_filter_usage` |
| `20260907_metadata_nested_search_facets` | Recursive `jsonb_to_text`, rebuilt FTS index, facet indexes, `v_slow_metadata_searches` |
| `20260908_compliance_training` | Training tables, `v_compliance_certification_status`, seeded modules |

Each ships with a `.down.sql` rollback file, as the migration runner's pre-flight
check requires.

> The `20260907` down migration intentionally keeps the nested-aware
> `jsonb_to_text`. The `20260908` down migration **deletes certification
> records**, which are compliance evidence — export them first in any
> environment with real training history.
