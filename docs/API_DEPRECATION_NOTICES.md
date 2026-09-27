# API Deprecation Notices

**Issue #393** · **Last Updated:** August 2026 · **Applies to:** ProxyPay REST API

Old API endpoints lack deprecation warnings, so clients don't know when to
migrate. This document describes the **Deprecation Notice System** that:

1. Adds `Deprecation` / `Sunset` / `Link` response headers to deprecated endpoints.
2. Provides migration guide links in the documentation and on responses.
3. Monitors usage of deprecated endpoints via Prometheus.
4. Exposes an admin endpoint to view the deprecation timeline and usage.

---

## Table of Contents

1. [How it works](#how-it-works)
2. [Response headers](#response-headers)
3. [Which endpoints are deprecated](#which-endpoints-are-deprecated)
4. [Migration guide links](#migration-guide-links)
5. [Monitoring](#monitoring)
6. [Admin endpoint](#admin-endpoint)
7. [Adding or removing a deprecation notice](#adding-or-removing-a-deprecation-notice)
8. [References](#references)

---

## How it works

Deprecated endpoints are registered in a central
[`DeprecationRegistry`](../src/middleware/deprecation.ts) at application startup
(see [`deprecationSeed.ts`](../src/middleware/deprecationSeed.ts)). A global
Express middleware
([`deprecationMiddleware`](../src/middleware/deprecation.ts)) inspects every
incoming request and, when it matches a registered endpoint, stamps the response
with the standard headers below. It also records the request in a Prometheus
counter for usage monitoring.

The same registry drives OpenAPI spec generation
([`deprecationHandler.ts`](../src/openapi/deprecationHandler.ts)) so deprecated
operations are marked `deprecated: true` and annotated with `x-sunset` /
`x-deprecation-date` in the generated docs.

---

## Response headers

A deprecated endpoint response includes:

| Header | Value | Meaning |
|--------|-------|---------|
| `Deprecation` | `true` (or an ISO date if the endpoint was deprecated on a known date) | Signals the endpoint is deprecated. |
| `Sunset` | HTTP-date (e.g. `Wed, 01 Jan 2027 00:00:00 GMT`) | The date the endpoint will be removed. |
| `Link` | `<replacement>; rel="successor-version"` | Points at the replacement endpoint/version. |
| `Warning` | `299 - "<reason>"` | Human-readable reason for the deprecation. |

Example:

```bash
curl -i https://api.example.com/api/transactions

HTTP/1.1 200 OK
Deprecation: true
Sunset: Wed, 01 Jan 2027 00:00:00 GMT
Link: </api/v1/transactions>; rel="successor-version"
```

---

## Which endpoints are deprecated

The current deprecated set is the **legacy unversioned** paths that predate
explicit API versioning. They continue to work but are advertised as deprecated
so clients migrate to explicit `/api/v1/...` (or `/api/v2/...`) paths:

| Deprecated path | Replacement |
|-----------------|-------------|
| `/api/transactions/*` | `/api/v1/transactions/*` |
| `/api/disputes/*` | `/api/v1/disputes/*` |
| `/api/stats/*` | `/api/v1/stats/*` |
| `/api/vaults/*` | `/api/v1/vaults/*` |
| `/api/bulk` | `/api/v1/transactions/bulk` |

> The sunset date is configurable through the `DEPRECATION_SUNSET_DAYS`
> environment variable (default **210 days**, matching the documented "v1
> sunset = GA + 210 days" policy).

---

## Migration guide links

The deprecation notices point clients at the migration documentation:

- [`API_V1_TO_V2_MIGRATION.md`](./API_V1_TO_V2_MIGRATION.md) — step-by-step
  guide from v1 to v2 with before/after examples, a checklist, and a timeline.
- [`API_VERSIONING.md`](./API_VERSIONING.md) — how versioning, headers, and the
  deprecation policy work.

The `Link` response header's `successor-version` target is the primary machine
readable pointer; the docs above are the human readable guidance.

---

## Monitoring

Every request to a deprecated endpoint increments:

```
deprecated_endpoint_requests_total{method, route, replacement, sunset}
```

- `method` — HTTP method (e.g. `GET`, `POST`).
- `route` — the concrete request path.
- `replacement` — the successor-version target.
- `sunset` — the ISO date of the endpoint's sunset.

Query the Prometheus `/metrics` endpoint (or Grafana) to answer questions like:

- *"How much traffic still hits legacy `/api/transactions`?"*
- *"Which deprecated endpoints are closest to sunset but still hot?"*

```promql
sum by (route) (rate(deprecated_endpoint_requests_total[5m]))
```

---

## Admin endpoint

An admin-only API exposes the deprecation timeline and live usage.
All routes below require admin authentication (`/api/admin/...`).

### `GET /api/admin/deprecations`

Returns the full deprecation timeline for endpoints and API versions.

```json
{
  "endpoints": [
    {
      "path": "/api/transactions",
      "method": "ALL",
      "deprecatedSince": "2026-08-27",
      "sunsetDate": "2027-03-25",
      "replacement": "/api/v1/transactions",
      "reason": "Legacy unversioned endpoint ...",
      "status": "announced",
      "daysUntilSunset": 210
    }
  ],
  "apiVersions": [],
  "openApiAnnotations": []
}
```

### `GET /api/admin/deprecations/usage`

Returns current traffic counts per deprecated endpoint.

```json
{
  "usage": [
    {
      "path": "/api/transactions",
      "method": "ALL",
      "replacement": "/api/v1/transactions",
      "sunsetDate": "2027-03-25",
      "requests": 42
    }
  ],
  "generatedAt": "2026-08-27T00:00:00.000Z"
}
```

### `GET /api/admin/deprecations/migration-guide`

Returns the canonical migration documentation links so tooling can point
directly from a deprecation warning to guidance.

---

## Adding or removing a deprecation notice

Notices live in [`src/middleware/deprecationSeed.ts`](../src/middleware/deprecationSeed.ts).
To deprecate a new endpoint, add an entry to `LEGACY_DEPRECATED_ENDPOINTS`:

```ts
{
  path: "/api/legacy-endpoint",
  method: undefined,            // omit to match all methods, or "GET"/"POST"...
  replacement: "/api/v1/legacy-endpoint",
  reason: "Replaced by the versioned path.",
}
```

To **remove** an endpoint from the timeline (e.g. after sunset removal), delete
its entry. The registry is [idempotent](../src/middleware/deprecationSeed.ts) so
`seedDeprecations()` is safe to call multiple times.

---

## References

- Middleware: [`src/middleware/deprecation.ts`](../src/middleware/deprecation.ts)
- Registry seed: [`src/middleware/deprecationSeed.ts`](../src/middleware/deprecationSeed.ts)
- OpenAPI enhancement: [`src/openapi/deprecationHandler.ts`](../src/openapi/deprecationHandler.ts)
- Metrics: [`src/utils/metrics.ts`](../src/utils/metrics.ts)
- Admin routes: [`src/routes/admin/deprecations.ts`](../src/routes/admin/deprecations.ts)
- Migration guide: [`API_V1_TO_V2_MIGRATION.md`](./API_V1_TO_V2_MIGRATION.md)
- Versioning & policy: [`API_VERSIONING.md`](./API_VERSIONING.md)
