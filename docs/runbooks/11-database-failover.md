# Runbook 11 — Cross-Region Database Failover

**Severity:** P1 · **Owner:** On-call + eng lead

The primary-region RDS PostgreSQL instance is unavailable (AZ/region outage,
storage failure, corruption) and we need to promote the cross-region read
replica so the platform keeps serving. Also covers planned failover and
failback.

> This runbook assumes the cross-region replica exists (Terraform
> `enable_cross_region_replica = true`, see
> [`../CROSS_REGION_REPLICATION.md`](../CROSS_REGION_REPLICATION.md)) and that
> the app reads `DATABASE_URL`, `READ_REPLICA_URL` and `DR_DATABASE_URL` from
> its environment (`src/config/database.ts`).

---

## Symptoms

- `GET /ready` returns 503 with `checks.database: down` (primary unreachable).
- Alerts fire for DB connection failures / `too many clients` / elevated 5xx.
- `db_replica_lag_seconds` spikes then the replica goes unreachable (it is the
  only survivor of the region).
- AWS console shows the primary instance `Inaccessible` / `Failed`.

---

## Context

- The cross-region replica (us-west-2) streams WAL from the primary (us-east-1).
  **While the primary is down, the replica cannot replay new WAL** — it is a
  read replica, not a multi-master. Promoting it makes it a standalone primary
  that accepts writes; the old primary (if it returns) must NOT be used for
  writes again until a full re-establishment.
- RPO: replica lag at the moment of outage. Check it before promoting.
- The app already supports DR mode: when `DR_DATABASE_URL` is set it reports
  `failover` mode (`/api/admin/database/replication`, `db_dr_mode=1`).

---

## Decision gate — before you promote

| Question | Action |
|----------|--------|
| Is this a **short** blip (< a few minutes) and the primary is coming back? | **Do not fail over.** Wait it out; failover has RPO/divergence costs. |
| Is the primary region truly lost / ETA unknown? | Proceed to planned failover. |
| Is the replica lag within acceptable RPO? | `aws rds describe-db-instances` → check replica; lag metric `ReplicaLag`. |
| Are we confident the primary won't come back and split-brain? | Stop the app / cut DNS only after promotion. |

---

## Failover procedure (unplanned / region loss)

### 1. Communicate

- Open the incident channel. Declare DR failover. Freeze deploys.

### 2. Confirm the DR replica is the newest copy

```bash
# From a box that can reach both (usually a bastion or CI runner):
aws rds describe-db-instances \
  --region us-west-2 \
  --query "DBInstances[?DBInstanceIdentifier=='mobile-money-production-postgres-dr'].{Status:DBInstanceStatus,Lag:ReplicaLag,LSN:LatestRestorableTime,Endpoint:Endpoint.Address}" \
  --output table

# Lag is also visible in CloudWatch (RDS > ReplicaLag) and app metrics:
curl -s localhost:3000/metrics | grep db_replica_lag_seconds
```

If lag is unacceptable for the business, consider restoring the latest snapshot
instead — promotion will lose everything replayed after the lag point.

### 3. Stop writes to the old primary (avoid split-brain)

If the primary region is still partially reachable:

```bash
# Scale the app down / stop the ECS service in the primary region,
# or put it in maintenance mode so it stops writing.
aws ecs update-service --cluster mobile-money-production \
  --service mobile-money-api --desired-count 0 --region us-east-1
```

### 4. Promote the replica

RDS cross-region read replicas are promoted with the AWS CLI / console. The
replica becomes a standalone multi-AZ-capable primary.

```bash
aws rds promote-read-replica \
  --db-instance-identifier mobile-money-production-postgres-dr \
  --region us-west-2

# Wait for status to become 'available' and role to flip to primary:
aws rds describe-db-instances --region us-west-2 \
  --query "DBInstances[?DBInstanceIdentifier=='mobile-money-production-postgres-dr'].DBInstanceStatus"
```

### 5. Repoint the application

Set the new endpoint as the primary and the old primary as the DR URL so the
app reports failover mode and monitors the old region's health:

```text
DATABASE_URL=postgresql://mobilemoney:...@<dr-endpoint>:5432/proxypay_stellar
DR_DATABASE_URL=postgresql://mobilemoney:...@<old-primary-endpoint>:5432/proxypay_stellar
# Remove READ_REPLICA_URL (the old region's replicas are gone) or point it at
# any new in-region replica once created.
READ_REPLICA_URL=
```

Deploy in the surviving region (or point the existing stack's DNS at it). The
running service picks it up via env/config:

```bash
kubectl set env deploy/proxypay DATABASE_URL='postgresql://...@<dr-endpoint>...' \
  DR_DATABASE_URL='postgresql://...@<old-primary>...' READ_REPLICA_URL=''
# or, for ECS: update the task definition / SSM param and redeploy.
```

### 6. Verify

```bash
curl -s localhost:3000/ready | jq .checks
#  → database: ok, replication: ok|degraded, dr_mode: active

curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  localhost:3000/api/admin/database/replication | jq
#  → primary.mode: "failover", primary.url: <dr-endpoint>

curl -s localhost:3000/metrics | grep db_dr_mode
#  → db_dr_mode 1

npm run monitor:replication   # exit 0 when the new primary is healthy
```

Then run a real smoke test: create a deposit/payout, confirm writes land on the
new primary and reads return them.

---

## Failover procedure (planned / maintenance)

Same steps, but you can do them slowly and during a maintenance window:

1. Announce window; verify lag ≈ 0.
2. Put the app in maintenance/read-only mode (`APP_MAINTENANCE_MODE=true`) or
   scale to 0 in the primary region.
3. Promote the replica, repoint `DATABASE_URL`, set `DR_DATABASE_URL` to the
   old primary, clear `READ_REPLICA_URL`.
4. Run migrations on the new primary (`npm run migrate:up`) — the replica was
   in recovery so schema changes must be re-applied if they were made after it
   was created.
5. Smoke test, then re-enable traffic.

---

## Failback (returning to the original region)

Failback is a **full re-establishment**, never a "switch back":

1. Stand up a fresh primary in the original region (restore from the promoted
   primary's snapshot / create a new replica of it and promote).
2. Point `DATABASE_URL` at the re-established original-region primary, set
   `DR_DATABASE_URL` to the (now old) promoted instance, recreate
   `READ_REPLICA_URL` entries.
3. Re-verify lag ≈ 0 and run `npm run reconcile:ledger` to confirm no
   divergence between regions.
4. Update Terraform so the *current* DR replica is tracked correctly; never
   `terraform apply` old state that would destroy the surviving data.

---

## Recover / return to steady state

- Re-create the cross-region replica from the new primary
  (Terraform + `aws rds create-db-instance-read-replica`).
- Confirm `db_dr_mode` returns to `0`, `db_replication_status` to `1`.
- Update the runbook with the actual timeline for the post-mortem.

---

## Verify

- [ ] `GET /ready` → `database: ok`, `dr_mode: active` during failover.
- [ ] Writes land on the promoted primary (smoke test deposit/payout).
- [ ] `npm run monitor:replication` exits 0.
- [ ] `npm run reconcile:ledger` passes (no imbalance).
- [ ] Old primary is not accepting writes (prevent split-brain).

---

## Post-incident

- Post-mortem: RPO achieved vs. promised, time-to-promote, why the region failed.
- If lag was high, right-size the replica / add a replication slot
  (`pg_create_physical_replication_slot`) to bound it.
- Practice this runbook quarterly (game day) — document the measured time.
- **Related:** [08](./08-replica-lag.md), [07](./07-db-pool-exhaustion.md).
