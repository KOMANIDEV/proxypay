# Runbook 05 — Redis Outage / Failover

**Severity:** P1 (Redis is a hard dependency for readiness) · **Owner:** On-call + eng lead

Redis is down, unreachable, or mid-failover. Redis backs sessions, caching,
BullMQ queues, rate limiting, distributed locks, and WebSocket pub/sub — so an
outage degrades nearly everything.

---

## Symptoms

- `/ready` returns 503 with `redis: down` or `redis: closed`.
- `/health/lb` failing → load balancer pulls the node out of rotation.
- `cache_hit_ratio` collapses; `cache_misses_total` spikes → DB load rises.
- Queue processing stalls (BullMQ needs Redis) — see [04](./04-queue-backlog.md).
- Logs: connection refused / `READONLY You can't write against a read only replica`.

## Context — Sentinel failover

- If Sentinel is enabled, the app listens for `+switch-master` events and
  force-reconnects (`src/config/redis.ts`).
- On a `READONLY` reply (connected to a replica after failover), the app forces
  a failover reconnect automatically. A brief blip during promotion is expected.

---

## Diagnose

```bash
# 1. App's own view
curl -s localhost:3000/ready | jq '.checks'

# 2. Is Redis reachable and who is master?
redis-cli -h <host> -p <port> ping
redis-cli -h <host> -p <port> info replication | grep -E 'role|master_link_status'

# 3. Sentinel view (if used)
redis-cli -h <sentinel-host> -p 26379 sentinel masters
redis-cli -h <sentinel-host> -p 26379 sentinel get-master-addr-by-name <master-name>

# 4. Memory / eviction pressure
redis-cli -h <host> -p <port> info memory | grep -E 'used_memory_human|maxmemory'
```

| Signal | Cause |
|--------|-------|
| Master unreachable, Sentinel promoting | Failover in progress — usually self-heals |
| `master_link_status:down` on replicas | Replication broken |
| `used_memory` at `maxmemory`, evictions | Memory exhaustion (see redis.conf) |
| Connection refused everywhere | Redis process/cluster down |

---

## Mitigate

1. **Failover in progress** — the app force-reconnects on `+switch-master` /
   `READONLY`. Give it up to the Sentinel `down-after-milliseconds` + promotion
   window. If pods are stuck on stale connections, roll them:
   ```bash
   kubectl rollout restart deploy/proxypay deploy/proxypay-worker
   ```

2. **Redis process/cluster down** — restart/replace the failed node. If managed
   (e.g. ElastiCache), trigger failover to a healthy replica from the console.

3. **Memory exhaustion** — check the eviction policy in `redis.conf`. If a queue
   or key set is ballooning, identify it (`redis-cli --bigkeys`) and address the
   producer. Scale Redis memory if genuinely undersized.

4. **Protect Postgres while cache is cold** — cache misses now hit the DB
   directly. Watch DB load and be ready to shed non-critical traffic; see
   [07 DB pool exhaustion](./07-db-pool-exhaustion.md).

---

## Recover

1. Confirm a single healthy master and connected replicas
   (`info replication`).
2. `/ready` returns 200 with `redis: ok` across all app pods.
3. Queues resume draining (runbook 04); `cache_hit_ratio` climbs back.

---

## Verify

- [ ] `/ready` and `/health/lb` return 200 on all pods.
- [ ] `role:master` on exactly one node; replicas `master_link_status:up`.
- [ ] `cache_hit_ratio` recovering; DB load back to baseline.
- [ ] Queue depth draining, no stuck jobs.

---

## Post-incident

- If failover was slow, review Sentinel `down-after-milliseconds` /
  `failover-timeout` and app reconnect behavior.
- If memory-driven, right-size `maxmemory` and confirm eviction policy suits
  cache vs. queue data (queues must not be evicted).
- Verify sessions/rate-limits degraded gracefully (no auth lockout storm).
- **Related:** [04](./04-queue-backlog.md), [03](./03-high-api-latency.md),
  [07](./07-db-pool-exhaustion.md).
