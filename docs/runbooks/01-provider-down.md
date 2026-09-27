# Runbook 01 — Mobile Money Provider Down

**Severity:** P2 (P1 if all providers for a country are down) · **Owner:** On-call

A mobile money provider (MTN MoMo, Airtel Money, Orange Money) is failing or
timing out. ProxyPay's circuit breaker has opened (or is flapping), so
deposits/payouts through that provider are being rejected or failed over.

---

## Symptoms

- Alert: `provider_circuit_breaker_state{provider="..."} == 1` (open).
- Rising `provider_failover_total` / `provider_failover_alerts_total`.
- `transaction_errors_total{error_type="provider_error"}` spiking for one provider.
- Users in one country report deposits/withdrawals failing or stuck.
- `provider_response_time_seconds` climbing before the breaker trips.

## How the breaker works (context)

- Opens after **`healthCheck.failureThreshold` = 3** consecutive failures
  (`HEALTH_CHECK_FAILURE_THRESHOLD`).
- Stays open for **`healthCheck.openDurationMs` = 60000 ms** (1 min), then
  moves to half-open and probes with a single request.
- `provider_circuit_breaker_state`: `0`=closed (healthy), `1`=open (failing),
  `2`=half-open (probing).

---

## Diagnose

```bash
# 1. Which providers are affected, and breaker state?
curl -s localhost:3000/metrics | grep -E 'provider_circuit_breaker_state|provider_failover_total'

# 2. Per-provider latency and error breakdown
curl -s localhost:3000/metrics | grep -E 'provider_response_time_seconds|transaction_errors_total'
```

Grafana / Loki (see `../observability.md`):

```logql
{container="proxypay_app"} | json | error_type="provider_error"
```

Decide the root cause:

| Signal | Likely cause |
|--------|--------------|
| One provider 5xx / timeouts, others fine | Provider-side outage |
| All providers failing at once | Our egress / network / DNS / credentials |
| 401/403 from provider | Expired API credentials or token |
| Breaker flapping open↔closed | Provider degraded (partial), or threshold too tight |

Confirm provider-side outage independently:
- Check the provider's status page / partner portal.
- `curl` the provider health/sandbox endpoint directly from a bridge host.

---

## Mitigate

**If it's a single provider outage (most common):**

1. Let the circuit breaker do its job — it's already failing fast and failing
   over. Confirm failover target providers are healthy (breaker `state=0`).
2. If a country has an alternate provider, ensure routing prefers the healthy
   one. If not, put deposits/withdrawals for that provider into a queued/retry
   state rather than hard-failing users where possible.
3. Post user-facing status: "<Provider> transactions are delayed."

**If it's our side (all providers failing):**

1. Verify outbound network + DNS from a bridge pod:
   ```bash
   kubectl exec -it deploy/proxypay -- sh -c 'curl -sS -o /dev/null -w "%{http_code}\n" https://<provider-host>/'
   ```
2. Check credentials/secrets have not expired or rotated:
   ```bash
   kubectl get secret proxypay-secrets -o jsonpath='{.data}' | jq 'keys'   # keys only, never values
   ```
3. If credentials expired, rotate and roll pods (see `scripts/rotate-keys.ts`).

**Do not** manually force the breaker closed against a genuinely-down provider —
that just converts fast failures into slow ones and floods retries.

---

## Recover

1. When the provider recovers, the breaker moves open → half-open → closed
   automatically after `openDurationMs`. Watch `provider_circuit_breaker_state`
   return to `0`.
2. Reprocess anything that was parked. Inspect and retry failed jobs in
   Bull-Board at `/admin/queues`, or via the admin CLI:
   ```bash
   npm run momo-cli -- --help    # discover retry subcommands
   ```
3. Confirm `transaction_total{status="success"}` recovers for that provider.

---

## Verify

- [ ] `provider_circuit_breaker_state == 0` for the provider.
- [ ] `transaction_errors_total{error_type="provider_error"}` flat again.
- [ ] A test deposit + payout through the provider succeeds.
- [ ] No orphaned/stuck transactions (spot check + see runbook 09 if unsure).

---

## Post-incident

- If the breaker flapped, review `failureThreshold` / `openDurationMs` — a
  degraded (not down) provider may need a longer open window.
- If credentials expired unnoticed, add/verify a cert/credential expiry alert
  (`npm run check-cert`).
- File provider-side incident reference; track their RCA.
- **Related:** [04 Queue backlog](./04-queue-backlog.md) (parked payouts),
  [10 Elevated error rate](./10-elevated-error-rate.md).

---

## Credential expiry (prevention)

The **provider token watchdog** (`provider-token-watchdog` cron job, every 5
minutes) catches expired/revoked authentication before it becomes an outage:

- **Mobile money (MTN/Airtel/Orange):** probes the provider auth endpoint with
  real credentials. A `401/403` raises a CRITICAL PagerDuty incident
  (`provider rejected our credentials`) instead of being counted as "up" by the
  uptime watchdog. Rotate the API key/secret in the secrets store and roll pods
  (`scripts/rotate-keys.ts` is for DB encryption keys, not provider secrets).
- **Accounting (Xero/QuickBooks):**
  - Access token already expired (scheduled refresh failed) → one auto-heal
    refresh attempt; if that fails, a CRITICAL PagerDuty incident fires:
    the refresh token has expired or been revoked and the user must
    re-authorize via the OAuth connect flow.
  - Refresh token stale (approaching the provider inactivity window: Xero
    60 days, QuickBooks 100 days) → warning webhook alert
    (`PROVIDER_TOKEN_ALERT_WEBHOOK_URL` / `SLACK_ALERTS_WEBHOOK_URL`) so the
    integration is reused or reconnected before the token dies.

PagerDuty events are deduplicated per provider/connection and auto-resolve when
credentials are refreshed or the connection is reconnected.
