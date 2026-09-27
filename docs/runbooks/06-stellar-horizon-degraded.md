# Runbook 06 — Stellar Horizon Degradation

**Severity:** P2 (P1 if all Horizon nodes are down and settlement stops) · **Owner:** On-call

Stellar Horizon (the API into the Stellar network) is slow, erroring, or down.
ProxyPay can rotate across a list of Horizon URLs; this runbook covers detecting
the failure and confirming failover.

---

## Symptoms

- `horizon_node_health{node="..."} == 0` for one or more nodes.
- `horizon_node_failures_total` / `horizon_request_failover_total` rising.
- Stellar-leg transactions slow or failing: `transaction_errors_total{error_type="stellar_error"}`.
- Deposits credited but Stellar settlement delayed (or vice-versa for withdrawals).

## Context

- `STELLAR_HORIZON_URL` may be a comma-separated list (primary first, then
  fallbacks) for automatic node rotation/failover (`src/config/env.ts`).
- The bridge fails over to the next node on failure and records it in
  `horizon_request_failover_total`.

---

## Diagnose

```bash
# 1. Per-node health and failover activity
curl -s localhost:3000/metrics | grep -E 'horizon_node_health|horizon_node_failures_total|horizon_request_failover_total'

# 2. Hit Horizon directly to see if it's Horizon or us
curl -s https://horizon.stellar.org/ | jq '{horizon_version, core_state: .core_status, latest_ledger}'
```

Check independently:
- Stellar network status page / status.stellar.org.
- `core_status` / ledger advancing — if `latest_ledger` is stale, the network
  or that node is stuck, not just slow.

| Signal | Cause |
|--------|-------|
| One node `health=0`, failover working | Single Horizon node issue — expected to self-mitigate |
| All nodes `health=0` | Network-wide Horizon issue, or our egress/DNS |
| 429 from Horizon | Rate limited — too many requests / need own node |
| Ledger not advancing | Stellar network degradation (rare) |

---

## Mitigate

1. **Single node down** — confirm failover is engaging
   (`horizon_request_failover_total` incrementing, other node `health=1`). No
   action needed beyond monitoring.

2. **All configured nodes unhealthy** — add a known-good Horizon endpoint to the
   front of `STELLAR_HORIZON_URL` and roll pods:
   ```bash
   kubectl set env deploy/proxypay STELLAR_HORIZON_URL="https://<good-node>,https://horizon.stellar.org"
   kubectl rollout status deploy/proxypay
   ```

3. **Rate limited (429)** — back off submission rate; if this recurs, plan a
   dedicated/paid Horizon instance. Ensure fee-bumping isn't retrying too
   aggressively (see `../FEE_BUMPING_IMPLEMENTATION.md`).

4. **Network degradation** — if ledgers aren't advancing network-wide, pause new
   Stellar submissions to avoid a pile-up of stuck transactions; queue them for
   replay. Communicate delays to users. Do not double-submit.

---

## Recover

1. When Horizon recovers, `horizon_node_health` returns to `1`.
2. Replay/verify any Stellar transactions that were queued or timed out —
   check by transaction hash on Horizon before resubmitting to avoid double
   settlement.
3. Confirm deposit↔settlement pairing is intact (see [09](./09-ledger-imbalance.md)).

---

## Verify

- [ ] `horizon_node_health == 1` for the primary node.
- [ ] `transaction_errors_total{error_type="stellar_error"}` flat.
- [ ] A test Stellar payment settles end to end.
- [ ] No transactions stuck between mobile-money and Stellar legs.

---

## Post-incident

- If a single public node keeps flapping, add more fallbacks or run a private
  Horizon.
- Alert on `latest_ledger` staleness, not just node health.
- **Related:** [04](./04-queue-backlog.md), [09](./09-ledger-imbalance.md),
  [10](./10-elevated-error-rate.md).
