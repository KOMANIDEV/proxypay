# ProxyPay Production Runbooks

**Status:** Production | **Last Updated:** July 2026

Operational runbooks for the most common production incidents on the ProxyPay
Mobile Money ↔ Stellar bridge. Each runbook is self-contained: symptoms →
diagnosis → mitigation → recovery → post-incident.

> For **deployment and rollback** procedures, see
> [`../BRIDGE_DEPLOYMENT_RUNBOOK.md`](../BRIDGE_DEPLOYMENT_RUNBOOK.md).
> These runbooks cover **running-system incidents** instead.

---

## How to use these runbooks

1. Identify the incident from the alert / symptom and open the matching runbook.
2. Work top-to-bottom. Every runbook is structured the same way:
   - **Symptoms** — what you (or the alert) see.
   - **Severity** — starting severity; escalate per the table below.
   - **Diagnose** — commands and queries to confirm the root cause.
   - **Mitigate** — fastest safe action to stop the bleeding.
   - **Recover** — return to steady state.
   - **Verify** — confirm the incident is resolved.
   - **Post-incident** — follow-ups and prevention.
3. If two runbooks seem to apply, start with the one matching the _earliest_
   symptom in the request path (e.g. provider outage before queue backlog).

---

## Incident catalogue (top 10)

| # | Runbook | Trigger / alert | Sev |
|---|---------|-----------------|-----|
| 01 | [Mobile money provider down](./01-provider-down.md) | `provider_circuit_breaker_state=1`, payout failures | P2 |
| 02 | [Database index bloat & slow queries](./02-database-index-bloat.md) | Rising query latency, `slow_query` logs | P3 |
| 03 | [High API latency](./03-high-api-latency.md) | P99 `http_request_duration_seconds` breach | P2 |
| 04 | [Queue backlog](./04-queue-backlog.md) | `total_depth` high, KEDA at max replicas | P2 |
| 05 | [Redis outage / failover](./05-redis-outage.md) | `/ready` shows `redis: down`, session/cache errors | P1 |
| 06 | [Stellar Horizon degradation](./06-stellar-horizon-degraded.md) | `horizon_node_health=0`, `horizon_node_failures_total` rising | P2 |
| 07 | [Database connection pool exhaustion](./07-db-pool-exhaustion.md) | `too many clients`, timeouts on `/ready` DB check | P1 |
| 08 | [Read-replica lag](./08-replica-lag.md) | `db_replica_lag_seconds` high, stale reads | P3 |
| 09 | [Ledger imbalance](./09-ledger-imbalance.md) | `reconcile:ledger` reports debits ≠ credits | P1 |
| 10 | [Elevated error rate](./10-elevated-error-rate.md) | Error-rate alert, `transaction_errors_total` spike | P2 |
| 11 | [Cross-region database failover](./11-database-failover.md) | `db_dr_mode=1`, `/ready` DB down, region outage | P1 |

---

## Severity levels

| Sev    | Definition                                                  | Response time           | Who                |
| ------ | ----------------------------------------------------------- | ----------------------- | ------------------ |
| **P1** | Funds at risk, or core deposit/withdraw path fully down     | Immediate, page on-call | On-call + eng lead |
| **P2** | Major degradation, one provider/path affected, no data loss | < 15 min                | On-call            |
| **P3** | Minor degradation, elevated latency, capacity risk          | < 1 hour (business hrs) | On-call / owner    |
| **P4** | Cosmetic / no user impact                                   | Next business day       | Owner              |

Escalate a level whenever: funds could be lost, the incident lasts > 30 min
without mitigation, or a second subsystem starts failing.

---

## Shared quick reference

### Health & metrics endpoints

| Endpoint                   | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `GET /health`              | Liveness — process is up (returns `gitHash`).                    |
| `GET /ready`               | Readiness — checks DB + Redis + shutdown state; 503 if any down. |
| `GET /health/lb`           | Load-balancer check (DB, Redis, memory < 1 GB); 5 s cached.      |
| `GET /health/queue`        | BullMQ queue health summary.                                     |
| `GET /health/queue/depth`  | `total_depth` — the value KEDA scales workers on.                |
| `GET /metrics`             | Prometheus scrape (all app metrics).                             |
| `GET /metrics/queue_depth` | Prometheus queue-depth metrics.                                  |
| `/admin/queues`            | Bull-Board dashboard (inspect/retry jobs).                       |

```bash
# Fast triage — is the app healthy end to end?
curl -s localhost:3000/ready | jq
curl -s localhost:3000/health/queue/depth | jq
```

### Key Prometheus metrics (see [`../metrics.md`](../metrics.md))

| Metric                                  | Use                                  |
| --------------------------------------- | ------------------------------------ |
| `http_request_duration_seconds`         | API latency (histogram; P95/P99).    |
| `http_requests_total`                   | Request volume & status codes.       |
| `transaction_total{status}`             | Deposit/payout throughput & success. |
| `transaction_errors_total{error_type}`  | Transaction failures by cause.       |
| `provider_circuit_breaker_state`        | 0=closed, 1=open, 2=half-open.       |
| `provider_failover_total`               | Provider failover events.            |
| `provider_response_time_seconds`        | Per-provider latency.                |
| `horizon_node_health`                   | Stellar Horizon node up/down.        |
| `db_replica_lag_seconds`                | Read-replica lag.                    |
| `cache_hit_ratio`                       | Redis cache effectiveness.           |
| queue depth (via `/health/queue/depth`) | BullMQ backlog.                      |

### Common tools

```bash
# Ledger integrity check
npm run reconcile:ledger
npm run reconcile:ledger -- --date=2026-07-30

# Database index maintenance
npm run audit:indexes                 # find unused/bloated indexes
npm run reindex:bloated-indexes       # REINDEX CONCURRENTLY eligible indexes

# Migrations
npm run migrate:status
npm run migrate:up
npm run migrate:validate     # static checks before touching the DB
npm run migrate:analyze      # impact analysis (objects created/altered/dropped)
npm run migrate:dry-run      # apply-verify without persisting
npm run test:migrations      # full up/down + per-migration rollback suite

# Backups
npm run backup:create
npm run backup:verify

# Admin CLI
npm run momo-cli -- --help
```

### Observability

- **Grafana / Loki** — LogQL error-rate & latency queries in
  [`../observability.md`](../observability.md).
- **Metrics reference** — [`../metrics.md`](../metrics.md).
- **Alerting** — PagerDuty (see `scripts/setup-pagerduty.sh`).
- **Log levels** — structured JSON; watch `ERROR`, `SECURITY`, `AUDIT`.

---

## Golden rules

1. **Communicate first.** Post in the incident channel before deep-diving.
2. **Mitigate before you diagnose** for P1/P2 — stop user impact, then find root cause.
3. **Never guess with funds.** For anything touching balances or the ledger,
   halt the affected flow and reconcile before resuming.
4. **Write it down.** Capture a timeline as you go; it becomes the post-mortem.
