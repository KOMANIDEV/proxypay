# Webhook Circuit Breaker, SEP-30 Recovery, Asset Validation and Account Merge Reviews

Covers issues #573, #572, #571 and #570. They are one pull request because they
are four answers to the same underlying question — *what happens when the other
side is broken?* — but they are otherwise independent and can be read or reverted
separately.

---

## Webhook circuit breaker (#573)

### The problem

`WebhookService` retries with exponential backoff. Backoff does not stop the
bleeding: once a destination starts refusing every delivery, every transaction in
the system keeps spending `maxAttempts` round trips and `maxDelayMs` of sleep per
event, against an endpoint already known to be dead. And a breaker that only
opens is not enough — a webhook that is never retried again is a webhook that
never comes back, even after the merchant has fixed it.

### Behaviour

| State | Delivery | Transitions |
| --- | --- | --- |
| `closed` | normal traffic; consecutive failures counted | → `open` at the threshold |
| `open` | refused immediately, no network call at all | → `half_open` after 24h |
| `half_open` | exactly one trial request admitted | → `closed` if it succeeds, → `open` if it fails |

The 24-hour cooldown is lazy: an `open` breaker becomes eligible for a probe on
the next delivery attempt after the window elapses, not on a timer. A breaker
nobody is talking to has no reason to change state.

The half-open gate admits **one** request. Everything else keeps waiting rather
than joining the probe, so a recovering endpoint sees a single request instead of
a backlog.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBHOOK_CIRCUIT_FAILURE_THRESHOLD` | 10 | Consecutive failed deliveries before opening |
| `WEBHOOK_CIRCUIT_RECOVERY_MS` | 86400000 (24h) | How long `open` lasts before a probe |

### Admin endpoints

```
GET  /api/admin/webhooks/circuit-breaker[?url=…]
POST /api/admin/webhooks/circuit-breaker/reset[?url=…]
```

Both require an admin JWT. The GET reports state, consecutive and lifetime
failure counts, the last error, and the next probe time — a breaker with a
cooldown is otherwise invisible, and an operator watching failed-delivery counts
has no way to tell "the endpoint refuses us" from "the breaker is holding back
deliveries to an endpoint that refuses nobody".

The reset exists because the cooldown is blunt. Omitting `?url=` resets every
destination this process has seen; pass it to reset one. Resets are logged with
the acting admin, previous state and previous error, because a manual reset
overrides an automatic protection and the audit trail has to say who decided the
protection was wrong.

### Metrics

| Metric | Type | Labels |
| --- | --- | --- |
| `webhook_circuit_breaker_transitions_total` | counter | `from`, `to`, `reason` |
| `webhook_circuit_breaker_skipped_total` | counter | `event_type` |
| `webhook_circuit_breaker_state` | gauge | `state` |

`webhook_circuit_breaker_skipped_total` is the number that should alarm an
operator: it counts transaction events a merchant did **not** hear about, so it is
a count of events they will reconcile by hand.

`webhook_circuit_breaker_state` writes all three series on every change. Setting
only the active state would leave a stale `1` behind for the state just left, and
a dashboard would show `open` and `closed` simultaneously — precisely when a human
is looking at it.

### Why not `src/utils/circuitBreaker.ts`

That module wraps one operation in an `opossum` breaker keyed
`provider:operation`, configured from `providerSettingsService`. A merchant's
webhook endpoint is not a provider, so reusing it means inventing a fake "webhook"
provider to satisfy the key space and filing webhook state alongside provider
health.

The integration shape differs too. `opossum` wants to own the whole call: run it,
classify the result, run a fallback if it rejects. Here the breaker is consulted
*before* an existing multi-attempt retry loop and told the verdict *after* the
loop gives up — the loop is what is being protected, not what the breaker wraps.
Forcing that through `executeWithCircuitBreaker` would mean either running the
retries inside the fallback (a failure would look like a successful fallback) or
duplicating the retry loop.

State is in-process on purpose. It is a rate-limiting decision about the last few
minutes of traffic, not a record that must survive a restart: after a deploy the
first few deliveries re-probe the destination, which is the half-open behaviour
we want anyway.

### Counting failures

A failed delivery is reported once, after the retry loop is exhausted — not once
per attempt. Counting each attempt would trip the breaker on a single flaky
delivery; the signal the breaker needs is "this endpoint is broken", and a
delivery that failed three times is one failure from the breaker's point of view.

---

## SEP-30 key recovery (#572)

### Signer set bounds

| Bound | Value | Enforced |
| --- | --- | --- |
| Minimum | 1 | On removal — a key always retains at least `recovery_threshold` signers, and the threshold is at least 1, so the last signer cannot be removed |
| Maximum | 15 | On insert |

Adding the *first* signer is always allowed; that is how a key acquires a
recovery path at all.

The ceiling is operational policy rather than a cryptographic limit. A 3-of-15
ceremony is already unpleasant to run, and past 15 signers the ceremony costs more
than the risk it mitigates while adding keys to track and revoke. It is enforced
in the service because no schema constraint can express "at most 15 rows for this
key". A concurrent double-add can still exceed the cap by one, because the count
is read before the insert; closing that fully needs a serializable transaction or
a counter column maintained by the database.

### Removing a signer during a live session

Refused. A session snapshots its `required_approvals` when it opens, so removing
a signer mid-ceremony can leave a session that can no longer reach its threshold
— and it still holds the "one active session" slot, so the recovery cannot simply
be restarted either. Complete or cancel the session first.

### Rate limiting

The recovery routes get a dedicated limiter, tighter than anything else in the
system: **5 operations per 15 minutes**.

| Route | Limiter |
| --- | --- |
| `POST/GET /keys`, `PATCH /keys/:id/threshold`, signers, rotate | generic 20/min |
| `POST /keys/:keyId/recovery/session` | generic + recovery |
| `POST /keys/:keyId/recovery/initiate` | generic + recovery |
| `POST /keys/:keyId/recovery/approve` | generic + recovery |
| `POST /keys/:keyId/recovery/complete` | generic + recovery |
| `POST /keys/:keyId/recovery/cancel` | generic + recovery |
| `GET` recovery session lists and audit | generic only |

Recovery is the one place in the product where a caller can drive a key rotation,
and each approval attempt is cheap for an attacker and expensive for the
operator: a successful recovery locks every legitimate signer out of the key.
Five attempts per fifteen minutes leaves room for a real 3-of-5 ceremony and no
room for guessing.

The recovery limiter is keyed on the authenticated user where there is one and on
the key id otherwise. Keying on the key is the point — a caller who rotates
identities is still working against the same key, and a per-user limit alone would
let one recovery be attacked from several accounts.

Unlike `sep24RateLimiter` and its neighbours, an unauthenticated caller is not
rejected with 401 here. The key id is still limited, so an anonymous flood is
bounded, and turning a rate limiter into an authentication check would change the
response code for a case already handled downstream.

### Tests

`tests/services/sep30Recovery.test.ts` covers concurrent session attempts, the
1/15 signer bounds, signer removal during a live session and at the threshold,
threshold changes, session expiry, and the approval and completion error paths.
Not executed in this PR.

---

## Asset issuance validation (#571)

### Migration

`20260830_create_asset_issuance_requests` creates the table
`assetWorkflowService` has been reading and writing since it landed. No migration
had ever created it, so the feature only worked against a database someone had
fixed by hand.

The constraint that matters is the **unique index on `asset_code`**. Duplicate
detection was a `SELECT` followed by an `INSERT`, which two concurrent requests
both pass. The database is the only place where a collision is knowable at the
moment it happens, so the constraint is the real check, the `SELECT` is a
friendlier fast path, and PostgreSQL `23505` is translated into the same error
message so callers handle one case instead of two.

Also enforced in the schema, not only in JavaScript: 3–12 alphanumeric characters,
a known status, a positive decimal limit. A colon is rejected in an asset code
because a colon is the separator in the `CODE:ISSUER` format the rest of the
codebase parses — a colon would let one asset be read back as a different one.

### Validation rules

| Field | Rule |
| --- | --- |
| `assetCode` | 3–12 characters, alphanumeric only |
| `name` | required, non-blank |
| `limit` | positive number; a warning above 1,000,000,000 |
| `issuer` | valid Stellar account (G…), and on the allowlist when one is configured |
| `distributionAccount` | valid Stellar account (G…) |

The 3-character floor is ours, not Stellar's — Stellar permits 1. A 1–2 character
code cannot be told apart from a typo at a glance.

Account validation uses `StrKey.isValidEd25519PublicKey`, which rejects a secret
key as well as junk. A secret key is the most damaging plausible mistake: the
string is well formed, so a looser check would accept it and leak it.

### Issuer allowlist

`ASSET_ISSUER_WHITELIST` is a comma-separated list of public keys. The platform's
own issuer — derived from `STELLAR_ISSUER_SECRET` — is always implicitly allowed,
so an operator issuing under their own key needs no configuration. Malformed
entries are ignored with a warning rather than failing every request.

**If the variable is unset, any valid issuer is allowed** and the decision is
logged at warn. This is a deliberate trade-off, and worth being explicit about:
it means the allowlist protects only deployments that configure one, and a
misconfigured value that parses to nothing silently disables the protection.
Rejecting everything by default would look like an outage in a deployment that
never opted in. Set the variable to get the protection.

A non-whitelisted issuer is an **error**, not a warning. It is a request to issue
an asset this platform is not supposed to be issuing, and approving it later
would be a mistake rather than a risk to be weighed.

### Rate limiting

`assetIssuanceRateLimiter` allows **10 write operations per hour per admin** and
is applied to every mutating route, including `POST /issue`, which creates a real
on-chain asset and previously had no limit at all. Reads are unthrottled: a list
endpoint is not worth a budget, and rate limiting reads would break the approval
queue for no security benefit.

---

## Account merge reviews (#570)

### Migration

`20260830_create_account_merge_reviews`. Reviews were held in a process-local
`Map`, so every decision was lost on restart, on a deploy, and across the two
instances behind the load balancer. A merge approval is a decision to move funds;
a decision that evaporates is either a stuck merge or, worse, an approval
recollected later under different circumstances.

`dry_run_report` is stored as JSONB verbatim. A reviewer approves the numbers
they actually saw, so recomputing the report later would mean approving something
nobody looked at. `reclaimable_xlm` is denormalised alongside it so the pending
queue can be sorted by value without parsing JSONB on every read.

### Guarantees the `Map` could not provide

**One pending review per account**, via a partial unique index on
`source_public_key WHERE status = 'pending'`. The `Map` happily held fifty open
reviews of one account, and a reviewer could approve one of them with no way to
tell which was current.

**Decisions are not silently overwritten.** The decision is a single
`UPDATE … WHERE id = $1 AND status = 'pending'`. Two reviewers clicking approve at
the same moment is not hypothetical, and the second must be told the review was
already decided rather than overwriting the first decision and the first
reviewer's name. A miss distinguishes the two cases: no such review (400) versus
already decided (409).

**Reviews expire after 7 days.** A dry run is a snapshot of a moment, and an
approval of a report from three weeks ago approves numbers that have since
changed. `assertReviewIsFresh` is checked before recording a decision because the
`UPDATE` guard alone is not enough: a review can be `pending` *and* stale if
nobody has run the sweep. Expiry sets `status = 'expired'` rather than deleting —
the record of a review that went stale is part of the audit trail, and `expired`
is what distinguishes "nobody looked at this" from "somebody looked and said no".

The schema also enforces that a decided review has both a `reviewed_at` and a
`reviewed_by`, and that a pending one has neither. That is what makes the audit
trail worth having.

### API change

`submitForMerchantReview`, `recordMerchantReviewDecision`,
`getMerchantReviewRecord` and `getPendingMerchantReviews` are now **async**,
because they are not expressible synchronously over durable storage — that is
what the `Map` was. `clearReviewStore` is gone, since there is no longer any
process-local state to clear; tests mock the database instead.

Added: `expireStaleMerchantReviews(ttlDays?)` and
`assertReviewIsFresh(reviewId)`.

### Review identifiers

IDs are database-generated UUIDs. They used to be
`review-${sourcePublicKey}-${Date.now()}`, which collided for two submissions of
the same account within one millisecond and leaked the account key into an
identifier that ends up in log lines and URLs.

### Rollback warning

The `.down.sql` drops the table outright. That is destructive in a way the asset
migration's is not: a dropped row is a lost record of who approved moving a
merchant's funds. Archive before rolling back if real decisions exist.

---

## Tests

Added, and **not executed** — this change was made without running the test
suite, build, lint or `tsc`, so these are executable specifications rather than
verified results.

| File | Covers |
| --- | --- |
| `src/services/__tests__/webhookCircuitBreaker.test.ts` | breaker state machine, probe gating, reset, per-destination isolation, metrics |
| `src/services/__tests__/assetWorkflow.test.ts` (extended) | #571 validation, allowlist, duplicate detection |
| `tests/services/accountMergeDryRun.test.ts` (updated) | #570 store, rewritten against a mocked database |
| `tests/services/sep30Recovery.test.ts` | #572 signer bounds, live-session guards, session lifecycle, error paths |

Three pre-existing test files could not load at all, because their imports
resolved outside `src/services`: `assetWorkflow.test.ts`,
`merchantPortalService.test.ts` and `pagerDutyService.test.ts` all imported
`../services/X` from inside `src/services/__tests__/`, and two had a second wrong
path to `config/database`. Fixed. A repo-wide sweep found roughly 23 further
unresolved relative imports in files unrelated to these four issues; those are
left alone.
