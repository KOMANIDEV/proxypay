# Runbook 04 — Queue Backlog

**Severity:** P2 (P1 if payouts are the backed-up queue and funds are stuck) · **Owner:** On-call

BullMQ jobs are accumulating faster than workers can process them. Deposits,
payouts, provider balance alerts, or account-merge jobs are delayed.

---

## Symptoms

- Alert on queue depth: `total_depth` from `/health/queue/depth` staying high.
- KEDA has scaled workers to `maxReplicaCount` (20) and depth is still rising.
- Users report deposits/withdrawals "pending" longer than usual.
- `latency_ms` (age of oldest waiting jobs) growing in the depth response.

## How scaling works (context)

- KEDA polls `GET /health/queue/depth` every 30 s and reads `total_depth`.
- Scales the **worker** Deployment up when `total_depth > 20` per replica.
- `minReplicaCount = 1`, `maxReplicaCount = 20`, `cooldownPeriod = 60 s`
  (`k8s/keda-scaled-object.yaml`).

---

## Diagnose

```bash
# 1. Current depth, per-queue breakdown, and Redis memory
curl -s localhost:3000/health/queue/depth | jq
curl -s localhost:3000/health/queue | jq

# 2. Are workers actually scaling / running?
kubectl get scaledobject proxypay-worker-scaledobject
kubectl get deploy proxypay-worker -o wide
kubectl get pods -l app=proxypay-worker
```

Open **Bull-Board** at `/admin/queues` to inspect waiting/active/failed jobs
per queue and see failure reasons.

Determine which pattern you're in:

| Pattern | Likely cause |
|---------|--------------|
| Depth high, workers NOT scaling | KEDA / metrics-api trigger broken; check `/health/queue/depth` reachable in-cluster |
| Workers at max, still growing | Genuine overload, or a downstream dependency slow (provider/Stellar/DB) |
| Many `failed` + retrying jobs | Poison job or downstream error causing retry storms |
| One queue backed up, others fine | That queue's downstream is the bottleneck |

---

## Mitigate

1. **Workers not scaling** — verify KEDA can reach the endpoint and it returns
   valid JSON:
   ```bash
   kubectl run curl --rm -it --image=curlimages/curl --restart=Never -- \
     curl -s http://proxypay-service.default.svc.cluster.local:3000/health/queue/depth
   ```
   If the trigger is broken, manually scale workers as a stopgap:
   ```bash
   kubectl scale deploy/proxypay-worker --replicas=20
   ```

2. **Genuine overload** — workers are maxed and healthy: the bottleneck is
   almost always downstream. Check and fix per:
   - Provider slow/down → [01](./01-provider-down.md)
   - Stellar Horizon slow → [06](./06-stellar-horizon-degraded.md)
   - DB slow / pool exhausted → [02](./02-database-index-bloat.md) / [07](./07-db-pool-exhaustion.md)

3. **Retry storm / poison job** — in Bull-Board, identify the failing job(s).
   Pause the queue if retries are amplifying load, fix/skip the poison job,
   then resume. Do **not** blanket-delete payout jobs — money may be involved.

4. **Redis memory pressure** — if `redis_memory_bytes` is near the limit, that
   caps queue throughput; see [05](./05-redis-outage.md).

---

## Recover

1. With the bottleneck cleared, watch `total_depth` drain toward 0 and
   `latency_ms` fall.
2. Reprocess failed jobs from Bull-Board once the downstream is healthy.
3. Let KEDA scale workers back down after the `cooldownPeriod`; remove any
   manual `kubectl scale` override so autoscaling resumes.

---

## Verify

- [ ] `total_depth` back to baseline (near 0 waiting).
- [ ] No growing `failed` count in `/admin/queues`.
- [ ] For payout queues: every job either completed or explicitly reconciled
      (cross-check with [09 Ledger imbalance](./09-ledger-imbalance.md)).
- [ ] Worker replica count returned to autoscaled baseline.

---

## Post-incident

- If the max of 20 workers was insufficient, raise `maxReplicaCount` and
  re-load-test (`npm run test:load:spike-10k`).
- If a poison job caused it, add validation/guardrails so it fails fast to a
  dead-letter state instead of retrying.
- Consider alerting on `latency_ms` (age) in addition to raw depth.
- **Related:** [01](./01-provider-down.md), [03](./03-high-api-latency.md),
  [05](./05-redis-outage.md), [06](./06-stellar-horizon-degraded.md).
