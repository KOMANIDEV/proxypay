# Runbook 02 — Database Index Bloat & Slow Queries

**Severity:** P3 (P2 if latency breaches SLA on the deposit/withdraw path) · **Owner:** On-call

Postgres index bloat (dead tuples accumulating in indexes) is degrading query
performance. Symptoms overlap with high API latency (runbook 03) — this runbook
covers the *database* root cause.

---

## Symptoms

- Rising `slow_query` log entries (threshold `SLOW_QUERY_THRESHOLD_MS`, default 1000 ms).
- API P99 climbing while CPU/traffic are roughly flat.
- `db_replica_lag_seconds` rising (bloat inflates replication work).
- Growing disk usage on the DB volume without a matching data-growth reason.

---

## Diagnose

```bash
# 1. What queries are slow? (structured JSON logs)
```
```logql
{container="proxypay_app"} | json | type="slow_query"
```

```bash
# 2. Audit indexes — unused, redundant, and bloated
npm run audit:indexes -- --verbose
```

In `psql`, confirm bloat and check for missing index maintenance:

```sql
-- Top tables/indexes by dead tuples
SELECT relname, n_dead_tup, n_live_tup,
       round(n_dead_tup::numeric / NULLIF(n_live_tup,0), 3) AS dead_ratio,
       last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;

-- Index sizes (largest first)
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;

-- Is a query using the expected index?
EXPLAIN (ANALYZE, BUFFERS) <the slow query>;
```

Interpretation:
- High `dead_ratio` + old `last_autovacuum` → autovacuum falling behind.
- `idx_scan = 0` over a long window → unused index (write overhead, drop candidate).
- Two indexes covering the same columns → redundant.

---

## Mitigate

1. **Reindex bloated indexes** — non-blocking (`REINDEX CONCURRENTLY`), safe to
   run online but prefer a low-traffic window:
   ```bash
   npm run reindex:bloated-indexes
   ```
   This finds bloated, eligible indexes and rebuilds them concurrently.

2. **If one query is hot and unindexed**, add the index concurrently:
   ```sql
   CREATE INDEX CONCURRENTLY idx_<table>_<cols> ON <table> (<cols>);
   ```

3. **If autovacuum is behind** on a specific table, kick it manually:
   ```sql
   VACUUM (ANALYZE) <table>;
   ```

Avoid a plain `REINDEX` (non-concurrent) or `VACUUM FULL` on live tables —
both take heavy locks and will cause an outage.

---

## Recover

1. Re-run the audit to confirm bloat is reduced:
   ```bash
   npm run audit:indexes
   ```
2. Drop genuinely-unused indexes only after confirming across a full traffic
   cycle (weekday + weekend); use the drop SQL the audit emits.
3. Watch `db_replica_lag_seconds` return to baseline.

---

## Verify

- [ ] `slow_query` log volume back to baseline.
- [ ] `EXPLAIN ANALYZE` on the previously-slow query shows expected index usage.
- [ ] API P99 (`http_request_duration_seconds`) recovered — see runbook 03.
- [ ] Replica lag normal.

---

## Post-incident

- If bloat recurs, schedule `reindex:bloated-indexes` as a cron job in a
  low-traffic window (the script is built for this).
- Tune autovacuum for hot tables (`autovacuum_vacuum_scale_factor`).
- Add the offending query pattern to load tests so regressions surface early.
- **Related:** [03 High API latency](./03-high-api-latency.md),
  [08 Read-replica lag](./08-replica-lag.md).
