# API Migration Guide: v1 → v2

**Status:** v2 in development (beta not yet released) · **Last Updated:** July 2026 · **Applies to:** ProxyPay REST API

This guide is for API clients preparing to move from **v1** (current stable) to
**v2**. It lists every planned breaking change, gives before/after examples, and
provides a checklist and timeline so you can migrate with zero downtime.

> **Read this first — v2 is not yet live.**
> The v2 routes are mounted at `/api/v2/*` but currently return
> `501 Not Implemented` (`{"error":"Not Implemented","message":"V2 API is coming soon"}`).
> This guide is published **ahead of** the beta so you can plan and adapt your
> integration early. Do **not** point production traffic at `/api/v2` until the
> beta is announced (see [Timeline](#timeline)). Nothing in v1 changes before
> then, and v1 will not be broken before its sunset date.
>
> For the underlying versioning mechanics (how a version is selected, response
> headers, error format), see [`API_VERSIONING.md`](./API_VERSIONING.md).

---

## Table of Contents

1. [Who needs to migrate](#who-needs-to-migrate)
2. [How to select a version](#how-to-select-a-version)
3. [Breaking changes at a glance](#breaking-changes-at-a-glance)
4. [Detailed changes with before/after examples](#detailed-changes-with-beforeafter-examples)
   - [1. Response envelope](#1-response-envelope)
   - [2. Transaction status → transaction state](#2-transaction-status--transaction-state)
   - [3. Search & filtering](#3-search--filtering)
   - [4. Webhooks replace polling](#4-webhooks-replace-polling)
   - [5. Legacy unversioned endpoints removed](#5-legacy-unversioned-endpoints-removed)
6. [Migration checklist](#migration-checklist)
7. [Timeline](#timeline)
8. [Early-adopter feedback](#early-adopter-feedback)
9. [FAQ](#faq)

---

## Who needs to migrate

You need to migrate if your integration does any of the following:

- Calls **legacy unversioned** endpoints (e.g. `POST /api/transactions/deposit`).
  These already return `Deprecation` headers and redirect to `/api/v1`.
- Pins to **v1** explicitly (`/api/v1/...` or `Accept-Version: v1`) and wants the
  v2 feature set (webhooks, advanced filtering, richer transaction states).

If you are happy on v1, you have until the **v1 sunset date** (see
[Timeline](#timeline)) before any action is required. v2 adoption is opt-in.

---

## How to select a version

Version is resolved in this priority order (unchanged between v1 and v2):

1. **URL path** (recommended): `/api/v2/transactions/deposit`
2. **`Accept-Version` header**: `Accept-Version: v2`
3. **`Accept` header**: `Accept: application/json;version=v2`
4. **Default**: `v1` if nothing is specified

```bash
# Recommended: pin the version in the URL path
curl -X POST https://api.example.com/api/v2/transactions/deposit \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

**Best practice:** always pin a version explicitly in production. Relying on the
default (`v1`) means a future change to the default could silently move you.

---

## Breaking changes at a glance

| # | Area | v1 (current) | v2 (planned) | Impact |
|---|------|--------------|--------------|--------|
| 1 | Response envelope | Mixed: some endpoints return the object directly, some `{ data, pagination }` | Uniform `{ version, data, meta }` | **Breaking** — update all response parsers |
| 2 | Transaction status | Flat `status` string | `state` object (lifecycle) | **Breaking** — update status checks |
| 3 | Search/filtering | Basic `limit`/`offset` + a few filters | `state`, `date_from/to`, `amount_min/max`, `sort_by/order`, `limit/offset` | Additive, but param names change |
| 4 | Event delivery | Poll `GET /:id` for status | Subscribe to webhooks (`transaction.created/completed/failed`) | Additive; polling still works |
| 5 | Legacy endpoints | `/api/transactions/*` (deprecated, redirects to v1) | Removed | **Breaking** if you use unversioned paths |
| 6 | Auth | JWT bearer / session | JWT bearer / session (new schemes planned) | Watch this guide for updates |

> Items marked **Breaking** require code changes. Items marked *additive* are
> safe to adopt incrementally.

---

## Detailed changes with before/after examples

The v1 examples below reflect the **actual** current responses. The v2 examples
reflect the **planned** shape from the v2 specification and will be finalized
when the beta ships — treat them as the target to design against, not a frozen
contract.

### 1. Response envelope

**What changes:** v1 is inconsistent — the create/deposit response returns the
transaction fields at the top level, while list endpoints wrap results in
`{ data, pagination }`. v2 standardizes **every** response as
`{ version, data, meta }`.

**Before (v1 — `POST /api/v1/transactions/deposit`):**

```json
{
  "transactionId": "9f1c...",
  "referenceNumber": "PP-20260730-000123",
  "status": "pending",
  "jobId": "9f1c..."
}
```

**After (v2 — `POST /api/v2/transactions/deposit`):**

```json
{
  "version": "v2",
  "data": {
    "transactionId": "9f1c...",
    "referenceNumber": "PP-20260730-000123",
    "state": { "current": "pending", "since": "2026-07-30T12:00:00.000Z" },
    "jobId": "9f1c..."
  },
  "meta": { "timestamp": "2026-07-30T12:00:00.000Z" }
}
```

**Migration:** read the payload from `response.data` instead of the top level.
A defensive parser that handles both during transition:

```js
// Works against v1 and v2
function unwrap(body) {
  return body && typeof body === "object" && "data" in body && "version" in body
    ? body.data          // v2 envelope
    : body;              // v1 flat / legacy
}
```

### 2. Transaction status → transaction state

**What changes:** v1 exposes a flat `status` string. v2 replaces it with a
`state` object that captures the lifecycle (current state + timestamp, with room
for transition history).

**Before (v1 — `GET /api/v1/transactions/:id`):**

```json
{ "id": "9f1c...", "status": "completed", "amount": "100.00" }
```

**After (v2 — `GET /api/v2/transactions/:id`):**

```json
{
  "version": "v2",
  "data": {
    "id": "9f1c...",
    "state": { "current": "completed", "since": "2026-07-30T12:03:00.000Z" },
    "amount": "100.00"
  },
  "meta": { "timestamp": "2026-07-30T12:03:05.000Z" }
}
```

**Migration:** replace `tx.status === "completed"` with
`unwrap(body).state.current === "completed"`. The state vocabulary
(`pending`, `completed`, `failed`, …) matches the existing v1 status values, so
only the access path changes.

### 3. Search & filtering

**What changes:** v2 introduces richer, explicitly-named query parameters.

**Before (v1 — `GET /api/v1/transactions/search`):** basic `limit`/`offset`
pagination and a limited filter set; list responses look like:

```json
{
  "data": [ /* transactions */ ],
  "pagination": { "total": 42, "limit": 20, "offset": 0, "hasMore": true }
}
```

**After (v2 — `GET /api/v2/transactions/search`):** filter with
`state`, `date_from`, `date_to`, `amount_min`, `amount_max`, `sort_by`,
`sort_order`, `limit`, `offset`:

```bash
curl -G https://api.example.com/api/v2/transactions/search \
  -H "Authorization: Bearer <token>" \
  --data-urlencode "state=completed" \
  --data-urlencode "date_from=2026-07-01" \
  --data-urlencode "date_to=2026-07-31" \
  --data-urlencode "amount_min=10" \
  --data-urlencode "sort_by=created_at" \
  --data-urlencode "sort_order=desc" \
  --data-urlencode "limit=20"
```

**Migration:** map your v1 filters to the new parameter names and read results
from the `data` array inside the v2 envelope.

### 4. Webhooks replace polling

**What changes:** in v1 you poll `GET /api/v1/transactions/:id` until the status
settles. v2 lets you subscribe to lifecycle events and receive a push instead.

**After (v2 — `POST /api/v2/transactions/webhooks`):**

```bash
curl -X POST https://api.example.com/api/v2/transactions/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.example.com/hooks/proxypay",
    "events": ["transaction.created", "transaction.completed", "transaction.failed"]
  }'
```

**Migration:** this is **additive** — polling continues to work. Adopt webhooks
to cut latency and API call volume, but you are not forced to. Verify webhook
signatures on your endpoint before trusting payloads.

### 5. Legacy unversioned endpoints removed

**What changes:** unversioned paths like `POST /api/transactions/deposit`
currently work but respond with `Deprecation: true`, a `Sunset` date, and a
`Link` header pointing at the versioned URL. In v2 these are **removed**.

**Migration:** switch every call from `/api/...` to an explicit
`/api/v1/...` (no behavior change) or `/api/v2/...` (adopt v2). Grep your client
for request paths that start with `/api/` but lack a `/v1/` or `/v2/` segment.

---

## Migration checklist

Work through this in order. Nothing here requires v2 to be live except the final
verification steps.

**Prepare (can do now, against v1):**

- [ ] Inventory every ProxyPay endpoint your client calls.
- [ ] Replace any **unversioned** `/api/...` paths with explicit `/api/v1/...`.
      This is behavior-neutral and removes the deprecation warnings today.
- [ ] Confirm you send an explicit version (URL path preferred) on every request.
- [ ] Centralize response parsing so the envelope shape is handled in one place
      (see the `unwrap()` helper above).
- [ ] Replace direct `status` string checks with a single accessor you can
      repoint to `state.current` later.

**Adapt (when v2 beta is announced):**

- [ ] Point a **staging/sandbox** client at `/api/v2` and run your test suite.
- [ ] Update request payloads and search parameters to the v2 names.
- [ ] Update response parsers to read from the `{ version, data, meta }` envelope.
- [ ] Switch status logic to `state.current`.
- [ ] (Optional) Subscribe to webhooks and reduce polling.
- [ ] Verify auth still succeeds under any new v2 scheme.

**Cut over (before v1 sunset):**

- [ ] Run v1 and v2 side by side; compare results for parity.
- [ ] Migrate production traffic to `/api/v2`.
- [ ] Monitor error rates and the `API-Version` response header to confirm
      traffic is actually landing on v2.
- [ ] Remove v1 fallback code after a stable soak period.

---

## Timeline

Dates are anchored to **v2 GA** (general availability). Exact calendar dates
will be published with the beta announcement and on the `/api/version` endpoint.

| Phase | When | What it means for you |
|-------|------|-----------------------|
| **v1 stable** | Now | Current production version. No action required. |
| **v2 beta** | Next release | v2 endpoints go live behind a beta flag. Start testing in staging. |
| **v2 GA** | TBD | v2 is production-ready. Begin production cutover. |
| **v1 deprecation** | GA + 180 days | v1 responses gain `Deprecation: true` + `Sunset` headers. Still fully functional. |
| **v1 sunset** | GA + 210 days | v1 and legacy unversioned endpoints are removed. Migration must be complete. |

This matches the deprecation policy in
[`API_VERSIONING.md`](./API_VERSIONING.md): a minimum **180-day** deprecation
window is announced before any endpoint is removed, communicated via
`Deprecation`, `Sunset`, and `Link` response headers.

**How to track status programmatically:** poll the version endpoint and watch
the `Deprecation` / `Sunset` headers on your responses.

```bash
curl https://api.example.com/api/version
# {
#   "current": "v1",
#   "supported": ["v1", "v2"],
#   "deprecated": [],
#   "upcoming": ["v2"]
# }
```

---

## Early-adopter feedback

The issue asks that this guide be validated with feedback from early adopters.
That step is **owned by a human** and happens during the v2 beta — it can't be
completed by writing the doc alone. To close it out:

- **Who:** a handful of integration partners already on v1 (prioritize those
  still calling legacy unversioned endpoints).
- **When:** during the v2 beta, before GA.
- **What to collect:** did the breaking-changes table match what they hit? Were
  any changes missing? Did the before/after examples parse cleanly? Was the
  timeline workable?
- **Where:** track feedback on issue #276 and fold corrections back into this
  guide before GA. Update **Last Updated** and the v2 example payloads once the
  beta contract is frozen.

Until that loop is done, treat the v2 examples here as *provisional*.

---

## FAQ

**Q: Can I start migrating today?**
A: You can do all the *Prepare* steps now (pin versions, centralize parsing).
You can't test against v2 until the beta ships — the endpoints currently return
`501 Not Implemented`.

**Q: Will v1 break when v2 launches?**
A: No. v1 is untouched until its sunset date (GA + 210 days), with a 180-day
deprecation warning window first.

**Q: Are webhooks mandatory in v2?**
A: No. Polling still works. Webhooks are an additive option to reduce latency
and request volume.

**Q: What's the fastest way to stop the deprecation warnings I see now?**
A: Change unversioned `/api/...` calls to explicit `/api/v1/...`. Same behavior,
no warning headers.

**Q: How do I know my traffic is on v2?**
A: Check the `API-Version` response header — it echoes the resolved version on
every response.

---

## References

- [`API_VERSIONING.md`](./API_VERSIONING.md) — versioning mechanics, headers, error format
- [`BRIDGE_API_EXAMPLES.md`](./BRIDGE_API_EXAMPLES.md) — API usage examples
- Version middleware: `src/middleware/apiVersion.ts`
- v2 route stubs: `src/routes/v2/`
