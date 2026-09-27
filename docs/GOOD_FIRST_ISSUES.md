# Good First Issues

A curated catalog of **25 beginner-friendly issues** for new contributors. Every
issue below was verified against the current codebase (August 2026) and has:

- **Scope** — the exact files and behavior in play.
- **Acceptance criteria** — how a maintainer will judge the PR.
- **Mentor** — a maintainer who can answer questions. Mentors are suggested
  based on their commit history in the relevant area; feel free to swap or
  co-mentor.

## How to pick one

1. Issues are grouped by theme. The **Difficulty** column is a rough guide:
   - 🟢 **S** — under an hour of code, mostly verification/cleanup.
   - 🟡 **M** — a focused change with tests; a typical first PR.
2. Before starting, comment on the issue and tag the mentor so they know you're
   working on it.
3. Follow [CONTRIBUTING.md](../CONTRIBUTING.md): fork, branch
   (`feature/your-feature`), conventional commits, and include tests.
4. Quality bar: `npm run lint`, `npm run type-check`, `npm test` all green;
   new/changed code at **>80% coverage** (project minimum is 75%).

When filing each issue on GitHub, use the
[Good First Issue template](../.github/ISSUE_TEMPLATE/good_first_issue.md) and
add the `good first issue` label. The template asks for **Files to modify** and
**Helpful resources** — both are provided below.

---

## 🗺️ 1. Internationalization (i18n)

`en.json` is the source of truth with **122 keys**; `fr.json`, `es.json`,
`pt.json`, and `sw.json` each contain only **34 keys** — all four are missing
the same **88 keys** (mostly under `errors.*`, plus auth, KYC, and transaction
messages). Users of those locales currently fall back to English error text.

Verified gap (run from `src/locales/`):

```bash
node -e "const en=require('./en.json');const flat=(o,p='')=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'&&v?flat(v,p+k+'.'):[p+k]);const s=new Set(flat(en));console.log([...s].filter(k=>!new Set(flat(require('./fr.json'))).has(k)).length)"
# 88
```

### GFI-01 · French translations (`fr.json`)
- **Difficulty:** 🟡 M · **Est. effort:** 1–2 hrs
- **Scope:** Translate all 88 missing keys in `src/locales/fr.json`, mirroring
  the structure of `en.json`. Keep `errors.*` messages concise and
  user-friendly (these surface in API error responses).
- **Files:** `src/locales/fr.json`
- **Acceptance criteria:**
  - [ ] `fr.json` has the exact same key set as `en.json` (no missing, no extra).
  - [ ] All new values are translated to French (no English leftovers).
  - [ ] Placeholders (`{{amount}}`, `{{count}}`) preserved verbatim.
  - [ ] `npm run type-check` passes.
- **Mentor:** @winnpxl
- **Resources:** i18n usage in [CONTRIBUTING.md](../CONTRIBUTING.md) →
  Internationalization; `src/utils/i18n.ts`

### GFI-02 · Spanish translations (`es.json`)
- **Difficulty:** 🟡 M · **Est. effort:** 1–2 hrs
- **Scope:** Same as GFI-01 for `src/locales/es.json`.
- **Files:** `src/locales/es.json`
- **Acceptance criteria:**
  - [ ] Exact key parity with `en.json`.
  - [ ] All values translated to Spanish; placeholders preserved.
  - [ ] `npm run type-check` passes.
- **Mentor:** @winnpxl

### GFI-03 · Portuguese translations (`pt.json`)
- **Difficulty:** 🟡 M · **Est. effort:** 1–2 hrs
- **Scope:** Same as GFI-01 for `src/locales/pt.json`.
- **Files:** `src/locales/pt.json`
- **Acceptance criteria:**
  - [ ] Exact key parity with `en.json`.
  - [ ] All values translated to Portuguese; placeholders preserved.
  - [ ] `npm run type-check` passes.
- **Mentor:** @sublime247

### GFI-04 · Swahili translations (`sw.json`)
- **Difficulty:** 🟡 M · **Est. effort:** 1–2 hrs
- **Scope:** Same as GFI-01 for `src/locales/sw.json`.
- **Files:** `src/locales/sw.json`
- **Acceptance criteria:**
  - [ ] Exact key parity with `en.json`.
  - [ ] All values translated to Swahili; placeholders preserved.
  - [ ] `npm run type-check` passes.
- **Mentor:** @sublime247

### GFI-05 · Guard against locale drift (parity test)
- **Difficulty:** 🟢 S · **Est. effort:** ~1 hr
- **Scope:** The existing `tests/utils/i18n.test.ts` tests locale *resolution*
  but never checks that locale files stay in sync. Add a test that loads every
  JSON in `src/locales/` and asserts the key sets are identical to `en.json`.
  Optionally wire it into CI (see `.github/workflows/`).
- **Files:** `tests/utils/i18n.test.ts`, possibly a new workflow
- **Acceptance criteria:**
  - [ ] Test fails if any locale is missing or adds keys vs `en.json`.
  - [ ] Test passes against the current tree.
  - [ ] Error message names the offending locale and lists missing keys.
- **Mentor:** @emmanuelist
- **Resources:** `jest.config.js` (test config), existing workflow files in
  `.github/workflows/`

---

## 🪵 2. Logging hygiene (structured logger)

The project standard (CONTRIBUTING.md: "No console.log statements (use proper
logging)") is the structured logger in `src/utils/logger.ts` (pino → Loki/Grafana).
Several runtime paths still use `console.log`. **Note:** some startup logging in
`src/index.ts` is intentional — leave it alone.

### GFI-06 · Structured logging in auth flows
- **Difficulty:** 🟢 S · **Est. effort:** 1–2 hrs
- **Scope:** Replace `console.log` with `logger.info/warn/error` in
  `src/auth/sso.ts` (~15 calls) and `src/auth/oidc.ts` (~6 calls). Preserve the
  log messages and any context objects.
- **Files:** `src/auth/sso.ts`, `src/auth/oidc.ts`
- **Acceptance criteria:**
  - [ ] No `console.log` remains in either file (search with `rg console.log src/auth`).
  - [ ] Structured form used: `logger.info({ ...context }, "message")` matching
        the style in `src/utils/logger.ts` callers.
  - [ ] No behavior change; `npm run lint`, `npm run type-check`, `npm test` pass.
- **Mentor:** @amochuko

### GFI-07 · Structured logging in WebSocket + GraphQL
- **Difficulty:** 🟢 S · **Est. effort:** ~1 hr
- **Scope:** Replace `console.log` with the structured logger in
  `src/websocket/websocketManager.ts` (connect/disconnect/pub-sub) and
  `src/graphql/server.ts` (WS auth), `src/graphql/redisPubSub.ts`,
  `src/graphql/apqCache.ts`.
- **Files:** `src/websocket/websocketManager.ts`, `src/graphql/server.ts`,
  `src/graphql/redisPubSub.ts`, `src/graphql/apqCache.ts`
- **Acceptance criteria:**
  - [ ] No `console.log` remains in the four files.
  - [ ] Messages include useful context (clientId, userId where available).
  - [ ] `npm test` passes (update any tests asserting `console.log`).
- **Mentor:** @shogun444
- **Resources:** `tests/websocket.test.ts` (existing coverage for the manager)

### GFI-08 · Structured logging in scheduled jobs
- **Difficulty:** 🟢 S · **Est. effort:** 1–2 hrs
- **Scope:** Replace `console.log` with `logger.*` in `src/jobs/scheduler.ts`,
  `src/jobs/sanctionSyncJob.ts`, `src/jobs/travelRuleAuditReportJob.ts`,
  `src/jobs/providerHealthCheck.ts`, `src/jobs/sep31FeeBumpJob.ts`.
- **Files:** the five job files above
- **Acceptance criteria:**
  - [ ] No `console.log` remains in those files.
  - [ ] Any tests that asserted `console.log` output are updated to assert on
        the logger instead (search `console.log` under `tests/jobs/` and
        `src/tests/jobs/`).
  - [ ] `npm test` passes.
- **Mentor:** @teetyff

---

## 🧹 3. Type safety — removing `any`

The codebase targets strict TypeScript; these files are the worst offenders.

### GFI-09 · Type the SEP-31 job metadata
- **Difficulty:** 🟡 M · **Est. effort:** 2–3 hrs
- **Scope:** `src/jobs/sep31FeeBumpJob.ts`, `src/jobs/sep31MonitorJob.ts`, and
  `src/jobs/feeBumpJob.ts` pass around `metadata: any`, `row: any`, and
  `currentMetadata: any` (~15 sites). Introduce a shared
  `Sep31TransactionMetadata` interface (see `src/services/transactionMetadataService.ts`
  and how `src/stellar/webhooks.ts` reads `(transaction.metadata as any)?.sep31`)
  and replace the `any`s.
- **Files:** `src/jobs/sep31FeeBumpJob.ts`, `src/jobs/sep31MonitorJob.ts`,
  `src/jobs/feeBumpJob.ts`
- **Acceptance criteria:**
  - [ ] No `any` remains in the three files.
  - [ ] A shared metadata type lives in `src/types/` (or is exported from
        `transactionMetadataService`).
  - [ ] `npm run type-check` passes; existing job tests still pass
        (`npm test -- sep31`).
- **Mentor:** @teetyff

### GFI-10 · Type the OIDC/JWKS code
- **Difficulty:** 🟡 M · **Est. effort:** 2–3 hrs
- **Scope:** `src/auth/oidc.ts` uses `any` for JWKS key arrays, `profile`
  payloads, and `params` (~10 sites: `jwksCache`, `fetchJwks`,
  `findSigningKey`, `validateGoogleOIDCProfile`, `validateAzureOIDCProfile`).
  Define minimal interfaces (`Jwk`, `OIDCProfile`) for what is actually read.
- **Files:** `src/auth/oidc.ts`
- **Acceptance criteria:**
  - [ ] No `any` remains in `src/auth/oidc.ts` (test files excluded).
  - [ ] Interfaces reflect the fields actually accessed (e.g. `kid`, `alg`,
        `sub`, `email`, `name`).
  - [ ] `npm run type-check` passes.
- **Mentor:** @amochuko

### GFI-11 · Type the transaction row mapper
- **Difficulty:** 🟡 M · **Est. effort:** 2 hrs
- **Scope:** `src/models/transaction.ts` declares `[key: string]: any` on the
  `Transaction` type and `mapTransactionRow(row: any): any`. Give
  `mapTransactionRow` a typed input (`TransactionRow` / `pg` row) and a typed
  return (`Transaction`), removing the index-signature `any` where feasible.
- **Files:** `src/models/transaction.ts`
- **Acceptance criteria:**
  - [ ] `mapTransactionRow` has explicit input/output types.
  - [ ] No `any` in the function signatures of `transaction.ts`.
  - [ ] `npm run type-check` passes; `npm test -- transactions` passes.
- **Mentor:** @devfoma

### GFI-12 · Resolve the stale FIX comment in stellar config
- **Difficulty:** 🟢 S · **Est. effort:** 30–45 min
- **Scope:** `src/config/stellar.ts` line ~30 carries a `// FIX: Change 'network
  as any' ...` comment, but the current code already types `network` via
  `as StellarNetwork`. Verify the typing is correct, delete the stale comment,
  and confirm `validateStellarNetwork()` rejects invalid values with the
  existing unit tests (or add one if none exists).
- **Files:** `src/config/stellar.ts`, `tests/config/` (add test if missing)
- **Acceptance criteria:**
  - [ ] Stale `FIX` comment removed; no `as any` introduced.
  - [ ] A test covers `validateStellarNetwork()` for valid + invalid +
        missing `STELLAR_NETWORK` (env restored after each case).
  - [ ] `npm run type-check` and `npm test` pass.
- **Mentor:** @emmanuelist

---

## 🧪 4. Tests for security-critical utilities

Each of these utilities has **zero dedicated tests** (verified by searching
`tests/`, `src/utils/__tests__/`). They guard money movement, signatures, and
audit trails — good coverage here matters.

### GFI-13 · Unit tests for request signing (`requestSigning.ts`)
- **Difficulty:** 🟡 M · **Est. effort:** 3–4 hrs
- **Scope:** `src/utils/requestSigning.ts` implements RSA-PSS request signing
  (issue #291): `buildCanonicalMessage`, `signMessage`, `buildSigningHeaders`,
  `verifySignature`, `verifyRequest`, `generateKeyPair`. Write a dedicated test
  suite in `tests/utils/requestSigning.test.ts`.
- **Files:** `tests/utils/requestSigning.test.ts` (new)
- **Acceptance criteria:**
  - [ ] Round-trip: `buildSigningHeaders` → `verifyRequest` returns
        `{ valid: true }`.
  - [ ] Tamper cases rejected: wrong body, wrong path, expired timestamp
        (set `REQUEST_SIGNING_TIMESTAMP_TOLERANCE` to a small value),
        missing headers, garbage signature.
  - [ ] `buildCanonicalMessage` is deterministic and includes the SHA-256 body hash.
  - [ ] **>80% coverage** on `src/utils/requestSigning.ts`
        (`npm run test:coverage`).
- **Mentor:** @Francis6-git
- **Resources:** existing patterns in `tests/utils/redact.test.ts`,
  `tests/utils/encryption.test.ts`

### GFI-14 · Unit tests for audit-event logging (`log-audit-event.ts`)
- **Difficulty:** 🟡 M · **Est. effort:** 2–3 hrs
- **Scope:** `src/utils/log-audit-event.ts` writes audit rows
  (`logAuditEvent`) and reads them back (`queryAuditEvents`) with pagination.
  Mock `src/config/database`'s `pool` and cover both functions.
- **Files:** `tests/utils/log-audit-event.test.ts` (new)
- **Acceptance criteria:**
  - [ ] `logAuditEvent` issues the expected INSERT with mapped params
        (userId → admin_id, meta fields, `diff` JSON when `extra` present).
  - [ ] DB errors are swallowed (no throw) and logged.
  - [ ] `queryAuditEvents` returns rows with camelCase aliases and respects
        limit/offset.
  - [ ] **>80% coverage** on `src/utils/log-audit-event.ts`.
- **Mentor:** @amochuko
- **Resources:** how `tests/services/auditlogService`-style tests mock `pool`
  (see `tests/jobs/sanctionSyncJob.test.ts` for a `pool.connect()` mock)

### GFI-15 · Unit tests for SEP-24 URL signing (`sep24Signature.ts`)
- **Difficulty:** 🟡 M · **Est. effort:** 2–3 hrs
- **Scope:** `src/utils/sep24Signature.ts` signs SEP-24 webview URLs (HMAC-SHA256)
  and verifies them in middleware. Cover `generateSignedSep24Url` and
  `verifySep24Signature` (as an Express middleware with mocked `req/res/next`).
- **Files:** `tests/utils/sep24Signature.test.ts` (new)
- **Acceptance criteria:**
  - [ ] Signed URL round-trips through `verifySep24Signature` → `next()` called.
  - [ ] Rejects: missing/invalid `sig`, missing/expired `exp`, tampered params,
        wrong secret.
  - [ ] Canonicalization is order-independent (same params, different order →
        same signature).
  - [ ] **Bonus (found while testing):** `generateSignedSep24Url` includes
        `undefined`-valued params in the canonical string (`key=undefined`) but
        omits them from the URL — signatures for such URLs fail verification.
        Fix or explicitly filter undefined values, with a regression test.
  - [ ] **>80% coverage** on `src/utils/sep24Signature.ts`.
- **Mentor:** @emmanuelist

### GFI-16 · Unit tests for shared error types (`errors.ts`)
- **Difficulty:** 🟢 S · **Est. effort:** 1–2 hrs
- **Scope:** `src/utils/errors.ts` defines the error classes/helpers used by
  controllers and middleware (error codes, HTTP status mapping, i18n keys).
  Read it, then write tests locking down construction, status codes, and any
  message/i18n-key behavior.
- **Files:** `tests/utils/errors.test.ts` (new)
- **Acceptance criteria:**
  - [ ] Every exported class/function has at least one test.
  - [ ] HTTP status and error-code mapping asserted for each error type.
  - [ ] **>80% coverage** on `src/utils/errors.ts`.
- **Mentor:** @Francis6-git

### GFI-17 · Unit tests for MCC + compression metrics helpers
- **Difficulty:** 🟢 S · **Est. effort:** 1–2 hrs
- **Scope:** `src/utils/merchantMcc.ts` (Merchant Category Code mapping) and
  `src/utils/compressionMetrics.ts` (compression ratio stats) have no tests.
  Read both, then write focused unit tests.
- **Files:** `tests/utils/merchantMcc.test.ts`, `tests/utils/compressionMetrics.test.ts` (new)
- **Acceptance criteria:**
  - [ ] Known MCC codes resolve to expected categories; unknown codes handled
        gracefully (documented fallback).
  - [ ] Compression metrics return sane values (0–100% style bounds, edge cases
        like empty input).
  - [ ] **>80% coverage** on both files.
- **Mentor:** @winnpxl

---

## 🧪 5. Tests for untested services

These services have **zero test files** referencing them (verified across
`tests/` and `src/services/__tests__/`). All are externally observable
behavior — good candidates for focused unit tests with mocked models/pool.

### GFI-18 · Tests for `invoiceService.ts`
- **Difficulty:** 🟡 M · **Est. effort:** 3–4 hrs
- **Scope:** `src/services/invoiceService.ts` generates transaction
  invoices/receipts (used by the `/api/transactions/:id/invoice` endpoint and
  `src/utils/receipt.ts`). Mock the models it depends on; cover happy path,
  missing transaction, and formatting (amounts, references).
- **Files:** `tests/services/invoiceService.test.ts` (new)
- **Acceptance criteria:**
  - [ ] Every exported function covered with happy path + failure cases.
  - [ ] Assertions on invoice fields (reference number format
        `TXN-YYYYMMDD-XXXXX`, amounts, currency).
  - [ ] **>80% coverage** on `src/services/invoiceService.ts`.
- **Mentor:** @dominiccreates
- **Resources:** `docs/REFERENCE_NUMBERS.md` (reference format),
  `tests/services/transactionPreview.test.ts` (mocking style)

### GFI-19 · Tests for `gdprService.ts`
- **Difficulty:** 🟡 M · **Est. effort:** 3–4 hrs
- **Scope:** `src/services/gdprService.ts` powers `/api/gdpr/export` (data
  export) and `/api/gdpr/delete` (right to be forgotten) plus the purge of
  deactivated accounts. This is compliance-critical; tests must lock down what
  is exported/scrubbed and that foreign keys survive.
- **Files:** `tests/services/gdprService.test.ts` (new)
- **Acceptance criteria:**
  - [ ] Export returns the expected PII buckets; delete anonymizes user rows
        (see `deactivateUserAccount` in `src/services/userService.ts`).
  - [ ] Deletion/purge paths preserve foreign-key integrity (no orphaned rows
        from the same transaction).
  - [ ] Errors surface as controlled failures, not unhandled rejections.
  - [ ] **>80% coverage** on `src/services/gdprService.ts`.
- **Mentor:** @amochuko
- **Resources:** `src/services/userService.ts` (deactivation),
  existing user service tests in `src/services/__tests__/user.service.test.ts`

### GFI-20 · Tests for `keyRotationService.ts`
- **Difficulty:** 🟡 M · **Est. effort:** 2–3 hrs
- **Scope:** `src/services/keyRotationService.ts` manages rotating encryption
  keys (see `src/utils/encryption.ts` for the `DB_ENCRYPTION_KEY_V*` scheme).
  Mock the crypto/config layer and cover rotation lifecycle, version bumps, and
  failure handling.
- **Files:** `tests/services/keyRotationService.test.ts` (new)
- **Acceptance criteria:**
  - [ ] Rotation advances the active key version and re-encrypts/keeps old keys
        readable as designed.
  - [ ] Failure mid-rotation leaves the previous version usable (no data loss).
  - [ ] **>80% coverage** on `src/services/keyRotationService.ts`.
- **Mentor:** @devfoma
- **Resources:** `src/utils/encryption.ts` (key-version semantics) and its tests
  in `tests/utils/encryption.test.ts`

### GFI-21 · Tests for `retentionPolicyService.ts`
- **Difficulty:** 🟢 S · **Est. effort:** 1–2 hrs
- **Scope:** `src/services/retentionPolicyService.ts` enforces data-retention
  windows (pairs with `gdprService` purge of `deactivated_at` rows). Mock
  `pool`/models and cover: nothing to purge, rows within window kept, expired
  rows purged, and pagination/batching if present.
- **Files:** `tests/services/retentionPolicyService.test.ts` (new)
- **Acceptance criteria:**
  - [ ] Retention boundary is exact (rows exactly at the cutoff are handled
        deterministically).
  - [ ] Purge runs in bounded batches (no unbounded query).
  - [ ] **>80% coverage** on `src/services/retentionPolicyService.ts`.
- **Mentor:** @shogun444

---

## ✨ 6. Small features from existing TODOs

### GFI-22 · Notify ops on critical reconciliation alerts
- **Difficulty:** 🟡 M · **Est. effort:** 2–3 hrs
- **Scope:** `src/jobs/providerReconciliationJob.ts` line ~77 contains
  `// TODO: Add notification logic (email, Slack, PagerDuty, etc.)`. Today
  critical/high provider-reconciliation alerts are only logged. Route them
  through `notificationRouter.routeSystemNotification(...)` with
  `severity: "critical" | "high"`, `category: "provider_reconciliation"`, and a
  stable `dedupKey` (e.g. `recon:<reference_number>`).
- **Files:** `src/jobs/providerReconciliationJob.ts`,
  tests in `src/jobs/__tests__/` or `tests/jobs/`
- **Acceptance criteria:**
  - [ ] Critical/high alerts trigger a routed system notification (email /
        pagerduty per `notificationRouter` rules).
  - [ ] No notification spam: identical alert within the dedup window is
        suppressed (use `dedupKey`).
  - [ ] Unit test mocks `notificationRouter` and asserts it is called with the
        right severity/category and NOT called for low-severity alerts.
  - [ ] `npm test` passes.
- **Mentor:** @shogun444
- **Resources:** `src/services/notificationRouter.ts` (API),
  `src/services/__tests__/notificationRouter.test.ts` (usage example)

### GFI-23 · Remove stale TODO in `userService.ts`
- **Difficulty:** 🟢 S · **Est. effort:** ~30 min
- **Scope:** `src/services/userService.ts` line ~278 has a stale
  `// TODO: The User type and database table needs to be updated with these
  fields: is_active, deactivated_at`. Both fields already exist in
  `src/models/users.ts` and the `users` table, and
  `src/services/__tests__/user.service.test.ts:65` already asserts the behavior.
  Verify, delete the comment, and (optionally) add an assertion that the
  `User` type includes both fields.
- **Files:** `src/services/userService.ts`
- **Acceptance criteria:**
  - [ ] Comment removed; no behavior change.
  - [ ] `User` type confirmed to include `is_active` and `deactivated_at`
        (already does — document that in the PR description).
  - [ ] `npm run type-check` and `npm test` pass.
- **Mentor:** @Francis6-git

---

## 📚 7. Documentation

### GFI-24 · Document the request-signing feature
- **Difficulty:** 🟢 S · **Est. effort:** 1–2 hrs
- **Scope:** `src/utils/requestSigning.ts` (issue #291) is a public-facing
  security feature — RSA-PSS request signing for high-value transactions above
  `REQUEST_SIGNING_THRESHOLD` (default 500,000 XAF) — with **no docs** anywhere
  (verified: zero hits for "request signing" in `docs/`). Write
  `docs/REQUEST_SIGNING.md` covering the canonical message format, headers
  (`X-Signature`, `X-Timestamp`, `X-Nonce`), clock-skew tolerance, key
  provisioning via `generateKeyPair()`, and a worked curl example.
- **Files:** `docs/REQUEST_SIGNING.md` (new); link it from `README.md` if appropriate
- **Acceptance criteria:**
  - [ ] Doc explains the format exactly as implemented
        (`METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)`).
  - [ ] Includes env vars (`REQUEST_SIGNING_THRESHOLD`,
        `REQUEST_SIGNING_TIMESTAMP_TOLERANCE`) with defaults.
  - [ ] Worked example matches `buildSigningHeaders` output semantics.
  - [ ] Spelling/links checked; renders on GitHub.
- **Mentor:** @amochuko
- **Resources:** `src/utils/requestSigning.ts`, style of `docs/REFERENCE_NUMBERS.md`

### GFI-25 · Document how to add translations
- **Difficulty:** 🟢 S · **Est. effort:** ~1 hr
- **Scope:** The i18n system (`src/utils/i18n.ts`, `src/locales/*.json`,
  `SUPPORTED_LOCALES`) is undocumented. Write `docs/I18N.md`: how keys are
  namespaced (`errors.*`, `auth.*`, …), how `t()` resolves locale
  (Accept-Language → `resolveLocale`), the requirement that all locales stay
  key-parity with `en.json`, and a step-by-step "add a new message in 5
  languages" walkthrough.
- **Files:** `docs/I18N.md` (new)
- **Acceptance criteria:**
  - [ ] Covers locale resolution order and fallback to `en`.
  - [ ] Includes the parity requirement and the check command from GFI-05.
  - [ ] Walkthrough example uses a real key added to all 5 locale files.
- **Mentor:** @winnpxl

---

## 📋 Summary table

| # | Issue | Difficulty | Area | Mentor |
|---|-------|-----------|------|--------|
| GFI-01 | French translations (`fr.json`) | 🟡 M | i18n | @winnpxl |
| GFI-02 | Spanish translations (`es.json`) | 🟡 M | i18n | @winnpxl |
| GFI-03 | Portuguese translations (`pt.json`) | 🟡 M | i18n | @sublime247 |
| GFI-04 | Swahili translations (`sw.json`) | 🟡 M | i18n | @sublime247 |
| GFI-05 | Locale key-parity guard test | 🟢 S | i18n/CI | @emmanuelist |
| GFI-06 | Structured logging in auth flows | 🟢 S | logging | @amochuko |
| GFI-07 | Structured logging in WebSocket + GraphQL | 🟢 S | logging | @shogun444 |
| GFI-08 | Structured logging in scheduled jobs | 🟢 S | logging | @teetyff |
| GFI-09 | Type SEP-31 job metadata | 🟡 M | types | @teetyff |
| GFI-10 | Type OIDC/JWKS code | 🟡 M | types | @amochuko |
| GFI-11 | Type transaction row mapper | 🟡 M | types | @devfoma |
| GFI-12 | Resolve stale FIX in stellar config | 🟢 S | types | @emmanuelist |
| GFI-13 | Tests for `requestSigning.ts` | 🟡 M | tests | @Francis6-git |
| GFI-14 | Tests for `log-audit-event.ts` | 🟡 M | tests | @amochuko |
| GFI-15 | Tests for `sep24Signature.ts` | 🟡 M | tests | @emmanuelist |
| GFI-16 | Tests for `errors.ts` | 🟢 S | tests | @Francis6-git |
| GFI-17 | Tests for MCC + compression metrics | 🟢 S | tests | @winnpxl |
| GFI-18 | Tests for `invoiceService.ts` | 🟡 M | tests | @dominiccreates |
| GFI-19 | Tests for `gdprService.ts` | 🟡 M | tests | @amochuko |
| GFI-20 | Tests for `keyRotationService.ts` | 🟡 M | tests | @devfoma |
| GFI-21 | Tests for `retentionPolicyService.ts` | 🟢 S | tests | @shogun444 |
| GFI-22 | Notify ops on critical reconciliation alerts | 🟡 M | feature | @shogun444 |
| GFI-23 | Remove stale TODO in `userService.ts` | 🟢 S | cleanup | @Francis6-git |
| GFI-24 | Document request-signing feature | 🟢 S | docs | @amochuko |
| GFI-25 | Document how to add translations | 🟢 S | docs | @winnpxl |

## Notes on mentors

Mentor handles are drawn from the project's actual contributor history
(`git shortlog`), matched to the area of each issue by the directories they
commit to most. If a mentor is unavailable, any maintainer can substitute —
the important thing is that every issue has a named human who has agreed to
answer questions. **Before publishing the issues, confirm each mentor is
willing to take assignments** (several share the same mentor, so confirm
bandwidth, not just availability).
