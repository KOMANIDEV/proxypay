# Cross-Region Database Replication (DR)

How ProxyPay replicates its PostgreSQL database across AWS regions, monitors
replication lag, and fails over when the primary region is lost.

## Topology

```
                      us-east-1 (primary)                    us-west-2 (DR)
┌──────────────────────────────────────────────┐   ┌──────────────────────────────┐
│  ECS Fargate → PgBouncer → RDS PostgreSQL 16 │   │  RDS PostgreSQL 16 (replica)  │
│                                ▲            │   │       ▲ (streaming WAL)        │
│                                └────────────┼───┼───────┘                        │
└──────────────────────────────────────────────┘   └──────────────────────────────┘
        ▲ reads via READ_REPLICA_URL (round-robin)      ▲ promote for failover
```

- **Primary:** RDS PostgreSQL 16 in `us-east-1` (Multi-AZ in production).
- **Cross-region replica:** an RDS read replica of the primary in `us-west-2`
  created via `replicate_source_db`. It continuously streams WAL and replays it.
- **App routing** (`src/config/database.ts`):
  - Writes → primary pool.
  - Reads → replica pools (`READ_REPLICA_URL`, comma-separated, round-robin),
    with automatic fallback to the primary when a replica is down or lagging
    beyond `REPLICA_SYNC_LAG_THRESHOLD_SECONDS` (default 5 s).
  - When `DR_DATABASE_URL` is set (after a promotion), the app reports
    **failover mode** — `getPoolStats()`/`/api/admin/database/replication`
    show `primary.mode = "failover"` and the `/ready` endpoint reports
    `dr_mode: active`.

## Provisioning (Terraform)

`terraform/` provisions everything. Cross-region replication is opt-in:

```hcl
# terraform/environments/production.tfvars
enable_cross_region_replica = true
dr_region                   = "us-west-2"
dr_db_instance_class        = "db.t3.small"
```

What it creates in the DR region (module `terraform/modules/database`):

- Minimal DR VPC + subnets + subnet group (`aws_vpc`, `aws_subnet`,
  `aws_db_subnet_group.dr`).
- A security group allowing PostgreSQL from the primary VPC CIDR.
- The replica instance `aws_db_instance.dr_replica` with
  `replicate_source_db = aws_db_instance.main.arn` (a second provider alias
  `aws.dr` targets the DR region).

Outputs after apply:

```bash
terraform output dr_db_endpoint       # host:port of the DR replica
terraform output dr_db_arn            # promotion target
terraform output dr_db_connection_url # postgres:// URL for READ_REPLICA_URL
```

## Application configuration

```text
DATABASE_URL=postgresql://user:pass@<primary-endpoint>:5432/proxypay_stellar
READ_REPLICA_URL=postgresql://user:pass@<dr-endpoint>:5432/proxypay_stellar   # cross-region replica
# ...or multiple replicas, comma-separated
READ_REPLICA_URL=postgresql://...replica-a...,postgresql://...replica-b...

# Failover mode (set after promotion):
DR_DATABASE_URL=postgresql://user:pass@<old-primary-endpoint>:5432/proxypay_stellar

# Lag controls
REPLICA_SYNC_LAG_THRESHOLD_SECONDS=5
REPLICA_LAG_MONITOR_INTERVAL_MS=10000
```

## Monitoring

| Signal | Source |
|--------|--------|
| `db_replica_lag_seconds{replica_url}` | in-process monitor in `database.ts` (every `REPLICA_LAG_MONITOR_INTERVAL_MS`) |
| `db_replica_read_enabled{replica_url}` | 1 = replica serving reads, 0 = disabled (down or lagging) |
| `db_dr_mode` | 1 = failover active, 0 = standby |
| `db_replication_status` | 1 = ok, 0 = degraded |
| `db_replica_count` | healthy, read-enabled replicas |

- **`/ready`** reports `checks.replication` (`ok`/`degraded`) and
  `checks.dr_mode` (`active`/`standby`). Replication lag never flips the pod to
  not-ready — reads fall back to the primary, so DR redundancy is preserved.
- **Admin API:** `GET /api/admin/database/replication` returns
  `{ primary: { mode, url, description }, replicas: [...] }`.
- **Grafana:** provisioned dashboard *Mobile Money — Database Replication*
  (`logging/grafana/provisioning/dashboards/db-replication.json`, Prometheus
  datasource) shows lag, read-routing, DR mode, overall status and replica
  count.
- **CLI / cron:** `npm run monitor:replication` checks every configured
  endpoint (primary, DR, replicas) and `pg_stat_replication` on the primary;
  exits 1 when anything is unreachable or lag exceeds the threshold.

Alert on: `db_replication_status == 0` (degraded) and `db_dr_mode == 1`
(failover active — page on-call, see runbook 11).

## Failover

Full step-by-step procedures (unplanned, planned, failback) live in
[`docs/runbooks/11-database-failover.md`](./runbooks/11-database-failover.md).

TL;DR:

1. Verify replica lag is within RPO.
2. Stop writes in the primary region (avoid split-brain).
3. `aws rds promote-read-replica --db-instance-identifier <...>-postgres-dr --region us-west-2`
4. Point `DATABASE_URL` at the promoted endpoint, set `DR_DATABASE_URL` to the
   old primary, clear `READ_REPLICA_URL`.
5. Verify via `/ready` (`dr_mode: active`), `GET /api/admin/database/replication`
   and `npm run monitor:replication`.

## Local development

`docker-compose.yml` includes a `postgres-replica` service that boots as a hot
standby of the local `postgres` primary (see
[`scripts/pg-replica-entrypoint.sh`](../scripts/pg-replica-entrypoint.sh)).
Point the app at it to exercise lag monitoring and read routing locally:

```text
READ_REPLICA_URL=postgresql://user:password@postgres-replica:5432/proxypay_stellar
```

For a local Kubernetes cluster, `k8s/postgres-replica.yaml` provisions the same
setup using an initContainer that runs `pg_basebackup`.

## Test coverage

`tests/config/database.failover.test.ts` covers the failover behaviour with a
mocked `pg` module:

- reads route to a healthy replica and round-robin across replicas;
- replica connection failure → fall back to primary;
- replica lag beyond threshold → replica disabled → fall back to primary;
- `checkReplicaHealth` / `getReplicationStatus` health, lag and DR mode;
- `getPoolStats` failover vs. normal mode;
- `querySmart` routes SELECT → replica, writes → primary.

`tests/routes/admin.test.ts` covers `GET /api/admin/database/replication`.

## References

- Terraform: `terraform/modules/database/main.tf` (DR section)
- App routing: `src/config/database.ts`, `src/utils/metrics.ts`
- Read routing details: [`./read-replica-routing.md`](./read-replica-routing.md)
- Lag incident runbook: [`./runbooks/08-replica-lag.md`](./runbooks/08-replica-lag.md)
- AWS: [Working with read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
