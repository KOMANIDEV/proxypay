# Runbook 08 — Read-Replica Lag

**Severity:** P3 (P2 if stale reads cause incorrect balances/decisions) · **Owner:** On-call

A Postgres read replica is lagging behind the primary. Reads routed to it return
stale data — users may see out-of-date balances, transaction status, or history.

---

## Symptoms

- `db_replica_lag_seconds` above threshold and climbing.
- Users report "my deposit isn't showing" / stale balances that self-correct.
- Read-after-write inconsistencies (write on primary, read from lagging replica).
- Possible cause or effect of DB load — see [02](./02-database-index-bloat.md) / [07](./07-db-pool-exhaustion.md).

## Context

- Read routing is controlled by `db_replica_read_enabled` (gauge: 1=enabled).
  Metrics/report queries use `queryRead()` to leverage replicas.
- The app can run in a DR `failover` mode where writes redirect to a promoted
  replica (`src/config/database.ts`).

---

## Diagnose

```bash
# 1. App's reported lag and whether replica reads are enabled
curl -s localhost:3000/metrics | grep -E 'db_replica_lag_seconds|db_replica_read_enabled'
```

On the **replica**:

```sql
-- Lag in seconds (0 or NULL when caught up / no traffic)
SELECT now() - pg_last_xact_replay_timestamp() AS replay_lag;
SELECT pg_is_in_recovery();  -- should be true on a replica
```

On the **primary**:

```sql
-- Per-replica send/write/flush/replay positions
SELECT client_addr, state, sent_lsn, replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_bytes_behind
FROM pg_stat_replication;
```

| Signal | Cause |
|--------|-------|
| `replay_bytes_behind` large & growing | Replica can't keep up (I/O, CPU, or a long query blocking replay) |
| Lag spikes during heavy writes | Write burst / bulk job (e.g. reindex, batch payout) |
| One replica lags, others fine | That replica's host is unhealthy |
| `state` not `streaming` | Replication broken / disconnected |

---

## Mitigate

1. **Protect correctness first.** If stale reads are causing wrong balances or
   decisions, disable replica reads so traffic goes to the primary until lag
   clears:
   ```bash
   kubectl set env deploy/proxypay DB_REPLICA_READ_ENABLED=false
   ```
   (Watch `db_replica_read_enabled` drop to 0. This raises primary load — keep
   an eye on [07](./07-db-pool-exhaustion.md).)

2. **Find what's blocking replay** on the replica — a long-running read query
   can pause WAL replay:
   ```sql
   SELECT pid, now() - query_start AS duration, left(query,120)
   FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC;
   ```
   Cancel the offender if safe.

3. **Write burst** — if a bulk job (reindex, batch payout, backfill) is driving
   lag, throttle or defer it to a low-traffic window.

4. **Replication broken** (`state` not `streaming`) — check replica logs, disk
   space, and network to primary; re-establish streaming / rebuild the replica
   if it fell too far behind (WAL recycled).

---

## Recover

1. Watch `db_replica_lag_seconds` fall back toward 0.
2. Re-enable replica reads once caught up:
   ```bash
   kubectl set env deploy/proxypay DB_REPLICA_READ_ENABLED=true
   ```
3. Confirm primary load returns to baseline after re-enabling.

---

## Verify

- [ ] `db_replica_lag_seconds` at baseline (near 0).
- [ ] `pg_stat_replication.state = 'streaming'` for all replicas.
- [ ] Read-after-write consistency confirmed with a test deposit.
- [ ] Primary connection count healthy (if reads were redirected).

---

## Post-incident

- If lag came from bulk jobs, schedule them off-peak and/or throttle batch size.
- If a replica repeatedly falls behind, right-size its host (I/O in particular).
- Consider `hot_standby_feedback` / `max_standby_streaming_delay` tuning tradeoffs.
- **Related:** [02](./02-database-index-bloat.md), [07](./07-db-pool-exhaustion.md).
