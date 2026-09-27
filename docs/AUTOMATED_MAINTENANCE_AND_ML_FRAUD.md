# Automatic Database Optimization, Provider Versions, Reversals & ML Fraud

This document covers four maintenance capabilities delivered together.

| Issue  | Capability | Entry point |
| ------ | ---------- | ----------- |
| #482   | Automatic database optimization | `src/services/databaseOptimizationService.ts` |
| #484   | Provider contract version management | `src/services/providerApiVersionService.ts` |
| #483   | Transaction reversal state tracking | `src/services/transactionReversalService.ts` |
| #485   | Machine-learning fraud detection | `src/services/mlFraudDetectionService.ts` |

Admin endpoints for all four live behind `requireAuth` under
`/api/admin/maintenance` (`src/routes/maintenanceRoutes.ts`).

---

## #482 — Automatic database optimization

### Why

Query latency drifts upward as dead tuples accumulate, index leaf pages
fragment and the planner re-plans identical statements. Remediation was manual
(`VACUUM`, `REINDEX` by hand), so it happened only after users complained.

### What it does

1. **Automatic vacuum/analyze** – `vacuumAndAnalyze()` runs
   `VACUUM (ANALYZE)` for the high-churn tables listed in
   `DEFAULT_VACUUM_TARGETS`. Missing tables and permission errors are skipped
   without aborting the cycle.
2. **Index fragmentation monitoring** – `monitorIndexFragmentation()` reads
   `pgstatindex().avg_leaf_density` for every non-unique index above the size
   floor, converts it to a fragmentation percentage and persists every sample
   to `index_fragmentation_history`.
3. **Index reorganization** – `reorganizeIndexes()` issues
   `REINDEX INDEX CONCURRENTLY` for indexes above
   `DB_OPTIMIZATION_REBUILD_THRESHOLD_PCT`, honouring a
   `DB_OPTIMIZATION_REINDEX_COOLDOWN_HOURS` cooldown. A concurrent rebuild
   (`55006`) is treated as a skip, not a failure.
4. **Query plan caching** – `cacheQueryPlan()` / `getCachedQueryPlan()` key
   plans on a normalised query fingerprint (literals and comments stripped) and
   flag a plan as regressed when the cost grows by more than
   `DB_OPTIMIZATION_PLAN_REGRESSION_RATIO`.
5. **Telemetry** – every cycle is recorded in `database_optimization_runs`,
   including failures, so the automation can be audited.

### Scheduling

Job `database-optimization` (default `30 3 * * *`, `DB_OPTIMIZATION_CRON`).
The REINDEX pass lands in the low-traffic window because `CONCURRENTLY` still
performs two table scans.

### Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `DB_OPTIMIZATION_JOB_ENABLED` | `true` | Master switch |
| `DB_OPTIMIZATION_CRON` | `30 3 * * *` | Schedule |
| `DB_OPTIMIZATION_MIN_INDEX_SIZE_MB` | `1` | Size floor for fragmentation checks |
| `DB_OPTIMIZATION_REBUILD_THRESHOLD_PCT` | `40` | Fragmentation that triggers a REINDEX |
| `DB_OPTIMIZATION_REINDEX_COOLDOWN_HOURS` | `24` | Minimum gap between rebuilds |
| `DB_OPTIMIZATION_PLAN_REGRESSION_RATIO` | `1.5` | Cost ratio that marks a plan regressed |

---

## #484 — Provider contract version management

`providerSchemaMonitorService` detects *shape* changes. This module tracks the
*version* a provider integration is pinned to.

- `registerProviderVersion()` records a version with its request-formatting
  profile and emits a `registered` notification.
- `validateCompatibility()` rejects a version that is unregistered, retired,
  past its sunset date, explicitly declared incompatible, or outside its
  declared bridge-version window. `assertCompatibleVersion()` throws so the
  check can guard a call site.
- `formatRequest()` applies the version profile: field renames, dropped
  fields, injected defaults, request enveloping. The input is never mutated.
- `setVersionStatus()` drives `active → deprecated → retired` and emits the
  matching notification for each transition.

Every lifecycle event is written to `provider_api_version_events`, giving an
immutable notification trail.

---

## #483 — Transaction reversal state tracking

The reversal path previously flipped the status and posted a compensating
ledger entry, with no record of who reversed what, why, or whether the
notification ever went out. Now each attempt is a durable record walking the
state machine:

```
requested ──▶ posted ──▶ notified
     └──────────┴──────▶ failed
```

- Every transition appends a row to `transaction_reversal_events` with the
  actor and detail payload.
- `notified` implies the merchant was told; a failure to deliver does **not**
  fail the reversal — the reversal is posted and the notification can be
  retried with `retryNotification()`.
- Terminal states (`notified`, `failed`) are never left.
- `findUnnotifiedReversals()` surfaces reversals still awaiting a
  notification.

Ledger posting remains delegated to `ledgerService.postReversal`, which is
idempotent, so a retried reversal never double-posts.

---

## #485 — Machine-learning fraud detection

The rule engine in `src/services/fraud.ts` stays the first line of defence.
The logistic-regression model runs alongside it as a second opinion for
patterns no rule covers.

- **Features** – `extractFeatures()` produces ten features: log amount, amount
  z-score vs the user's history, ratio to the user's historical maximum, hour
  of day, weekend flag, 1h/24h velocity (log), distinct counterparties (log),
  failed-transaction ratio and operator-assigned provider risk.
- **Model** – batch gradient descent, deterministic for identical input so the
  nightly job is reproducible. No external ML dependency.
- **Training pipeline** – `buildTrainingSet()` balances the classes so the
  rare fraud class is not drowned out; `trainAndPromote()` persists the
  artefact and promotes it atomically.
- **Accuracy monitoring** – `getModelMetrics()` reports offline precision /
  recall / F1 plus 24h prediction volume, flag rate and agreement with analyst
  feedback.
- **Human feedback loop** – `submitFeedback()` records the analyst label and
  immediately queues the transaction's feature vector into the next training
  set.

### Blending with the rule engine

`FraudService.detectFraud()` combines the two on a common 0–1 scale:

```
blended = heuristicScore + mlProbability * fraudScoreThreshold * 0.3
```

The model contributes 30% – enough to tip a borderline case without
overriding an explicit rule hit. If no model is active, or scoring fails, the
heuristic score is used unchanged. `FraudResult` exposes `heuristicScore` and
`mlScore` separately so the two signals stay auditable.

### Training schedule

Job `ml-fraud-training` (default `30 4 * * *`). A candidate is promoted only
when it beats the live model and clears `ML_FRAUD_MIN_F1` (default `0.6`);
otherwise the previous artefact is restored, so a bad training run never
degrades live scoring.

---

## Migrations

| Migration | Contents |
| --------- | -------- |
| `20260901_automatic_database_optimization` | `query_plan_cache`, `index_fragmentation_history`, `database_optimization_runs` |
| `20260902_provider_api_version_management` | `provider_api_versions`, `provider_api_version_compat`, `provider_api_version_events` |
| `20260903_transaction_reversal_tracking` | `transaction_reversals`, `transaction_reversal_events` |
| `20260904_ml_fraud_detection` | `ml_fraud_models`, `ml_fraud_training_examples`, `ml_fraud_predictions`, `ml_fraud_feedback` |

Each has a matching `.down.sql` so the standard rollback safety check passes.
