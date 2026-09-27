# Runbook 03 — High API Latency

**Severity:** P2 (P1 if requests are timing out on the deposit/withdraw path) · **Owner:** On-call

API responses are slow. This runbook isolates *where* the latency is —
application, database, cache, downstream provider, or Stellar — and mitigates.

---

## Symptoms

- Alert on P99 `http_request_duration_seconds` (buckets top out at 10 s).
- Users report slow API/app responses; possible request timeouts.
- `active_connections` climbing (requests piling up).
- Possible knock-on: queue backlog (runbook 04), pool exhaustion (runbook 07).

---

## Diagnose

```bash
# 1. Confirm latency and see which routes/status codes are slow
curl -s localhost:3000/metrics | grep -E 'http_request_duration_seconds|active_connections'
```

P99 latency by route in Grafana (Prometheus):

```promql
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
```

Or from logs (see `../observability.md`):

```logql
quantile_over_time(0.99, {container="proxypay_app"} | json | unwrap duration [5m])
```

Localize the bottleneck — check each layer:

| Layer | Check | Points to |
|-------|-------|-----------|
| DB | `slow_query` logs; `db_replica_lag_seconds` | Runbook 02 / 07 / 08 |
| Cache | `cache_hit_ratio` dropping, `cache_misses_total` up | Redis / runbook 05 |
| Provider | `provider_response_time_seconds` high | Runbook 01 |
| Stellar | `horizon_node_health`, `horizon_node_failures_total` | Runbook 06 |
| App/host | Node event-loop lag, CPU, memory (default metrics) | Scale out / profile |

```bash
# Readiness confirms DB + Redis reachability quickly
curl -s localhost:3000/ready | jq
```

---

## Mitigate

Act on whichever layer the diagnosis implicates:

- **Downstream (provider/Stellar) slow** → follow runbook 01 / 06; the circuit
  breaker and Horizon failover should shed load. Confirm they're engaging.
- **DB slow** → runbook 02 (bloat/slow query) or 07 (pool). A hot missing index
  is the most common cause of a sudden P99 jump.
- **Cache cold/down** → runbook 05; a Redis problem turns cache hits into DB
  reads and cascades latency everywhere.
- **App capacity** → scale horizontally. HPA targets 80% CPU, min 2 / max 10
  replicas (`k8s/hpa.yaml`):
  ```bash
  kubectl get hpa proxypay-hpa
  kubectl scale deploy/proxypay --replicas=<n>   # temporary manual bump
  ```
- **Runaway/expensive endpoint** → rate-limit or temporarily disable the
  offending route if it's non-critical.

Request timeouts are enforced globally (`globalTimeout`); confirm they're not
set so low they're manufacturing failures under load (see `../REQUEST_TIMEOUTS.md`).

---

## Recover

1. Once the implicated layer is fixed, watch P99 return under SLA.
2. Scale replicas back to baseline after load subsides (avoid leaving manual
   overrides that fight the HPA).
3. Drain any backlog that built up (runbook 04).

---

## Verify

- [ ] P99 `http_request_duration_seconds` back under SLA.
- [ ] `active_connections` at baseline.
- [ ] `/ready` returns 200 with DB + Redis `ok`.
- [ ] No sustained queue backlog.

---

## Post-incident

- Add a Grafana panel/alert for the specific route if it was a single endpoint.
- If capacity-driven, revisit HPA thresholds and load-test headroom
  (`npm run test:load`).
- **Related:** [02](./02-database-index-bloat.md), [04](./04-queue-backlog.md),
  [05](./05-redis-outage.md), [06](./06-stellar-horizon-degraded.md),
  [07](./07-db-pool-exhaustion.md).
