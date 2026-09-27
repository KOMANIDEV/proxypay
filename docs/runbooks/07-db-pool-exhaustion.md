# Runbook 07 — Database Connection Pool Exhaustion

**Severity:** P1 (writes failing = deposits/payouts failing) · **Owner:** On-call + eng lead

The Postgres connection pool (or the server's `max_connections`) is exhausted.
New queries block or fail, and `/ready` starts returning 503 on its DB check.

---

## Symptoms

- `/ready` returns 503 with `database: down`, intermittently.
- Errors: `sorry, too many clients already`, `remaining connection slots are
  reserved`, or pool `timeout acquiring a connection`.
- API latency spikes then errors (see [03](./03-high-api-latency.md)).
- Often triggered by a downstream slowdown holding connections open longer.

---

## Diagnose

```bash
# 1. App readiness / DB reachability
curl -s localhost:3000/ready | jq '.checks'
```

In `psql`:

```sql
-- How many connections, by state, and against the limit?
SELECT count(*) AS total,
       count(*) FILTER (WHERE state = 'active')              AS active,
       count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_txn
FROM pg_stat_activity;

SHOW max_connections;

-- Longest-running / stuck queries
SELECT pid, state, now() - query_start AS duration, left(query, 120) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY duration DESC
LIMIT 20;
```

| Signal | Cause |
|--------|-------|
| Many `idle in transaction` | A code path opens a txn and doesn't commit/rollback (leak) |
| Many long `active` queries | Slow queries holding connections — see [02](./02-database-index-bloat.md) |
| Total ≈ `max_connections` | Pool sized too high, or too many app/worker replicas |
| Spike aligns with traffic | Genuine load — need pooling / scaling, not a leak |

---

## Mitigate

1. **Kill offending sessions** (buys headroom immediately). Prefer cancel over
   terminate; never blanket-kill without reading the queries:
   ```sql
   -- Cancel long-running non-idle queries older than N minutes
   SELECT pg_cancel_backend(pid)
   FROM pg_stat_activity
   WHERE state = 'active' AND now() - query_start > interval '5 minutes';

   -- Terminate leaked idle-in-transaction sessions
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE state = 'idle in transaction' AND now() - state_change > interval '5 minutes';
   ```

2. **Reduce demand** — if a burst of replicas is the cause, the pool size ×
   replica count may exceed `max_connections`. Scale app/worker replicas *down*
   temporarily, or lower per-instance pool size and roll.

3. **Fix the upstream cause** — pool exhaustion is usually a *symptom*:
   - Slow queries holding connections → [02](./02-database-index-bloat.md).
   - Replica lag pushing reads to primary → [08](./08-replica-lag.md).
   - Downstream stall (provider/Stellar) holding request handlers open →
     [01](./01-provider-down.md) / [06](./06-stellar-horizon-degraded.md).

4. Route eligible reads to replicas if read-replica routing is disabled
   (`db_replica_read_enabled` gauge); see `../read-replica-routing.md`.

---

## Recover

1. Confirm connection count drops well below `max_connections`.
2. `/ready` returns 200 with `database: ok` across pods.
3. Return replica counts / pool sizes to baseline once stable.

---

## Verify

- [ ] `pg_stat_activity` total connections have headroom vs. `max_connections`.
- [ ] No `idle in transaction` sessions accumulating.
- [ ] `/ready` green on all pods; API latency normal.

---

## Post-incident

- If a leak: find the code path missing a commit/rollback and add a regression
  test. `idle in transaction` at zero is the target.
- Size the pool deliberately: `pool_size × (app + worker replicas) < max_connections`
  (leave a reserve for superuser + maintenance).
- Consider a server-side pooler (PgBouncer) if replica count is elastic.
- **Related:** [02](./02-database-index-bloat.md), [03](./03-high-api-latency.md),
  [08](./08-replica-lag.md).
