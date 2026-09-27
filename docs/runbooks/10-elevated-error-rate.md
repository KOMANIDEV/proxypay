# Runbook 10 — Elevated Error Rate (incl. Traffic Spike)

**Severity:** P2 (P1 if error rate on the deposit/withdraw path is high) · **Owner:** On-call

The overall error rate is elevated — a spike in 5xx responses and/or
transaction failures. This is often the *first* alert you get; use it to
localize which subsystem is failing, then jump to that runbook. Traffic spikes
are one common trigger and are handled here too.

---

## Symptoms

- Error-rate alert (see LogQL below) or 5xx spike in `http_requests_total`.
- `transaction_errors_total` climbing (by `error_type`).
- Possible correlated load: `active_connections` high, queue depth rising.

---

## Diagnose

```bash
# 1. Errors by status code and route
curl -s localhost:3000/metrics | grep -E 'http_requests_total|transaction_errors_total'
```

Error rate % (Grafana / Loki, from `../observability.md`):

```logql
sum(rate({container="proxypay_app"} | json | level="ERROR" [5m]))
/ sum(rate({container="proxypay_app"} [5m])) * 100
```

**Localize by `error_type`** on `transaction_errors_total` — this points
straight at the responsible runbook:

| `error_type` / signal | Root cause → runbook |
|-----------------------|----------------------|
| `provider_error` | Mobile money provider → [01](./01-provider-down.md) |
| `stellar_error` | Horizon degradation → [06](./06-stellar-horizon-degraded.md) |
| `exception` + DB errors | Slow queries / pool → [02](./02-database-index-bloat.md) / [07](./07-db-pool-exhaustion.md) |
| Redis/cache errors | Redis outage → [05](./05-redis-outage.md) |
| 5xx across all routes + high load | Traffic spike (below) |
| Errors since a deploy | Bad release → **roll back** (below) |

```bash
# 2. Did this start at a deploy? Compare error onset to rollout time.
kubectl rollout history deploy/proxypay
curl -s localhost:3000/health | jq .gitHash   # currently-running build
```

---

## Mitigate

### If it's a bad deploy
Roll back — fastest safe action:
```bash
kubectl rollout undo deploy/proxypay
kubectl rollout status deploy/proxypay
```
(See `../BRIDGE_DEPLOYMENT_RUNBOOK.md` → Rollback Procedures.)

### If it's a traffic spike
1. Confirm it's load, not a bug: 5xx broad, latency up, resources saturated.
2. Scale the API tier — HPA targets 80% CPU (min 2 / max 10, `k8s/hpa.yaml`);
   bump the ceiling or replicas if it's pinned:
   ```bash
   kubectl get hpa proxypay-hpa
   kubectl scale deploy/proxypay --replicas=<n>
   ```
   Workers autoscale on queue depth via KEDA (max 20) — see [04](./04-queue-backlog.md).
3. Rate limiting is multi-layer (`express-rate-limit`, `rate-limiter-flexible`);
   confirm limits are shedding abusive traffic without blocking legitimate
   users. Tighten temporarily if a single client/IP is the source.
4. Protect the data tier — a spike cascades into DB pool ([07](./07-db-pool-exhaustion.md))
   and Redis ([05](./05-redis-outage.md)); watch both.

### If it's one subsystem
Jump to the runbook the `error_type` table points to and mitigate there.

---

## Recover

1. Error rate returns under threshold; 5xx back to baseline.
2. Drain any backlog that accumulated ([04](./04-queue-backlog.md)).
3. Scale replicas back to baseline once load subsides; remove manual overrides.

---

## Verify

- [ ] Error rate % back under alert threshold (LogQL query above).
- [ ] `transaction_errors_total` flat across all `error_type`s.
- [ ] `/ready` green; latency and `active_connections` normal.
- [ ] Running `gitHash` is the intended build (if a rollback occurred).

---

## Post-incident

- Bad deploy → add the failure to CI (test/load) so it can't ship again;
  review canary/staging coverage in `../BRIDGE_DEPLOYMENT_RUNBOOK.md`.
- Traffic spike → revisit HPA/KEDA headroom and rate-limit thresholds; re-run
  `npm run test:load:spike-10k` to validate capacity.
- Ensure the error-rate alert links directly to this runbook.
- **Related:** all subsystem runbooks (01–09); this is the fan-out point.
