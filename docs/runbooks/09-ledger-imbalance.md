# Runbook 09 — Ledger Imbalance

**Severity:** P1 (money integrity) · **Owner:** On-call + eng lead + finance

The double-entry ledger fails to balance: total debits ≠ total credits, or
reconciliation reports orphaned transactions / invalid balances. Treat any
ledger imbalance as **funds-at-risk** until proven otherwise.

---

## Symptoms

- `reconcile:ledger` reports `ledgerBalanced: false` (non-zero `difference`).
- Reconciliation lists orphaned transactions or accounts with invalid balances.
- Cross-chain mismatch: `cross_chain_anomaly_total` incrementing, or
  `cross_chain_balance` gauge diverging from expected.
- Mobile-money leg completed without the matching Stellar leg (or vice-versa).

---

## Diagnose

```bash
# 1. Run reconciliation (optionally as-of a date)
npm run reconcile:ledger
npm run reconcile:ledger -- --date=2026-07-30
```

The report gives: `totalDebits`, `totalCredits`, `difference`, a trial balance,
plus `issues[]` and `warnings[]`. Read them before touching anything.

```bash
# 2. Cross-chain balance anomalies
curl -s localhost:3000/metrics | grep -E 'cross_chain_anomaly_total|cross_chain_balance'
```

In `psql`, localize the imbalance (adjust to schema; use the trial balance to
find which account is off):

```sql
-- Journal entries that don't net to zero per transaction.
-- Schema: ledger_entries(debit_amount, credit_amount, transaction_id, account_id, ...)
-- (immutable double-entry table; exactly one of debit_amount/credit_amount is non-zero per row)
SELECT transaction_id,
       sum(debit_amount)  AS debits,
       sum(credit_amount) AS credits,
       sum(debit_amount) - sum(credit_amount) AS diff
FROM ledger_entries
GROUP BY transaction_id
HAVING sum(debit_amount) <> sum(credit_amount)
ORDER BY abs(sum(debit_amount) - sum(credit_amount)) DESC
LIMIT 50;
```

| Signal | Likely cause |
|--------|--------------|
| Single txn off | Partial write / crash mid-transaction (one leg only) |
| Off since a deploy | Regression in ledger-writing code |
| Cross-chain gauge diverges | Stellar leg settled/failed without ledger update ([06](./06-stellar-horizon-degraded.md)) |
| Many small diffs | Rounding / fee-posting bug |

---

## Mitigate

1. **Contain first.** If a code path is actively writing unbalanced entries,
   pause the affected flow (e.g. stop the payout/settlement worker) so the gap
   stops growing. Do **not** delete or "fix up" ledger rows manually.
   ```bash
   # e.g. pause the affected queue in Bull-Board (/admin/queues) or scale workers to 0
   kubectl scale deploy/proxypay-worker --replicas=0
   ```

2. **Preserve evidence.** Snapshot the ledger tables / take a backup before any
   corrective action — this is a financial record.
   ```bash
   npm run backup:create && npm run backup:verify
   ```

3. **Triage the specific transactions** from the query above. For each, confirm
   the real-world truth on both legs:
   - Mobile-money leg: provider transaction status.
   - Stellar leg: transaction hash on Horizon.

4. Engage finance/eng lead. Correcting a ledger is a **compensating-entry**
   exercise (append correcting journal entries), never an in-place edit.

---

## Recover

1. Post compensating entries (via the proper ledger service path) so the books
   balance, referencing the incident. Never hand-edit historical rows.
2. Resume the paused flow only after the write bug (if any) is fixed and
   deployed.
3. Re-run `npm run reconcile:ledger` until `ledgerBalanced: true` with zero
   unexplained `issues[]`.

---

## Verify

- [ ] `reconcile:ledger` → `ledgerBalanced: true`, `difference == 0`.
- [ ] No orphaned transactions or invalid balances in the report.
- [ ] `cross_chain_anomaly_total` no longer incrementing; balances reconcile.
- [ ] Every triaged transaction matched to real provider + Stellar state.

---

## Post-incident

- Root-cause the write path: transactions must post both legs atomically
  (all-or-nothing) — add a test proving a crash mid-write cannot leave a
  half-posted entry.
- Add/confirm an automated scheduled `reconcile:ledger` with alerting on
  imbalance, so this is caught in minutes, not by users.
- Full financial post-mortem with finance sign-off.
- **Related:** [06](./06-stellar-horizon-degraded.md), [01](./01-provider-down.md),
  [04](./04-queue-backlog.md).
