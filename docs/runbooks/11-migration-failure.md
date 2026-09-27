# Runbook 11 — Database Migration Failure

**Severity:** P1 if it blocks deploys or leaves the schema half-applied on the
write path; P2 otherwise · **Owner:** On-call + DB owner

A schema migration failed to apply (or was discovered to have applied
incorrectly). The database may be in a **half-applied** state — some objects
changed, others did not. The goal is to determine exactly what happened, make
the schema consistent again without data loss, and prevent the failure from
recurring.

> **Golden rule:** never "fix" a failed migration by hand-editing the schema
> around it. Every fix must leave the migration chain reproducible from a
> fresh database — if it is not, the same state cannot be rebuilt in a
> disaster-recovery scenario.

---

## Symptoms

- Deploy pipeline fails at the `Run database migrations` step
  (`npm run migrate:up`).
- Alert: `Migration runner error:` in app logs, or `Failed to apply
<migration>`.
- `npm run migrate:status` shows an applied version with no matching file, or
  a pending version the deploy log says was applied.
- Application errors referencing objects a recent migration was supposed to
  create/drop (e.g. `relation "x" does not exist`, `column "y" does not
exist`).

---

## Diagnose

```bash
# 1. Where did the chain stop, and what does the DB think is applied?
npm run migrate:status

# 2. What is actually in the schema vs what the chain expects?
psql "$DATABASE_URL" -c "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 10;"
psql "$DATABASE_URL" -c "SELECT conname FROM pg_constraint WHERE conrelid = 'transactions'::regclass;"   # example

# 3. What did the failed migration try to do? Static checks + impact report
npm run migrate:validate
npm run migrate:analyze

# 4. Dry-run the pending chain against a scratch database to confirm the
#    failure reproduces and nothing else is broken
npm run migrate:dry-run
```

Key questions to answer before touching anything:

- **Did the runner wrap the migration in a transaction?** It does — each
  migration runs inside `BEGIN`/`COMMIT` with the version inserted in the same
  transaction. A failed `up` therefore leaves **no partial schema and no
  version recorded**, unless the migration uses a construct that cannot be
  rolled back (below).
- **Is the failure a genuine SQL error, or a state mismatch?** A mismatch
  (e.g. "table already exists", "column already exists", constraint-name
  collisions) usually means the migration was already applied by hand, or an
  earlier migration already created the object.
- **Was the database manually altered outside the chain?** The migration may
  be failing because production drifted from the chain (common with the
  partitioned `transactions` table).

### What cannot be rolled back

These leave permanent effects even inside a transaction:

- `CREATE INDEX CONCURRENTLY` / `REINDEX CONCURRENTLY` / `DROP INDEX
CONCURRENTLY` (cannot run in a transaction at all — they fail immediately
  with "cannot run inside a transaction block").
- `ALTER TYPE ... ADD VALUE` (the new value persists after rollback).
- `VACUUM`, `CLUSTER`, `CREATE DATABASE`.

If a migration contains one of these it must be applied as its own step and
its rollback handled manually — never retry blindly.

---

## Mitigate

1. **Stop the deploy / prevent retries.** Pause the pipeline so the failing
   migration is not re-attempted in a loop (each retry re-runs partial work
   and can hold locks).

2. **Freeze migrations for other services.** Multiple deploys racing through
   the same database is how half-applied states get worse.

3. **Do not hand-DDL around the failure yet.** First determine which case you
   are in:
   - **Case A — clean failure (rolled back):** `migrate:status` shows the
     migration still pending and the schema unchanged. Fix the migration file
     and re-run `migrate:up`. Nothing to repair.
   - **Case B — failure after a side effect that survived (see "What cannot
     be rolled back" above):** the version is pending but part of the change
     exists. Apply the missing pieces by completing the migration, or back
     the leftover objects out manually **only if** the chain can reproduce the
     same state afterwards.
   - **Case C — the migration applied but is wrong:** version recorded, schema
     inconsistent with the chain. Roll it back with the canonical path (below).

---

## Recover

### Roll back the last migration (canonical path)

```bash
npm run migrate:down
```

`down` runs the migration's `.down.sql` inside a transaction, removes the
version, and only then commits. If the down file itself fails, it rolls back
too — the schema is left untouched and the version stays, so you can iterate
on the down file safely.

If the failing migration is **not** the last one (e.g. it was applied out of
order), roll back in reverse order until you reach it:

```bash
npm run migrate:down   # repeat until the offending version is removed
```

### Restore from backup (last resort)

If rollback is impossible (no down file, destructive data migration already
ran) and the schema/data are corrupted:

```bash
npm run backup:create
# restore the most recent verified backup, then re-apply the chain from a
# known-good version:
npm run migrate:up
```

See [`../DATABASE_BACKUPS.md`](../DATABASE_BACKUPS.md) for the restore
procedure. Reapplying the chain from a backup is the only way to be sure the
database matches what a fresh environment would produce.

---

## Verify

- [ ] `npm run migrate:status` — every expected version applied, none pending
      that should be applied.
- [ ] `npm run migrate:dry-run` passes against a scratch database.
- [ ] `npm run test:migrations` passes — the full up/down + per-migration
      rollback suite (this exercises the exact migration that failed).
- [ ] App health: `curl -s localhost:3000/ready | jq` returns ok, no
      `relation does not exist` errors in logs.
- [ ] If the migration touched the ledger or balances, run
      `npm run reconcile:ledger` before resuming traffic.

---

## Post-incident

- **Fix the migration, not just the database.** The migration chain must
  reproduce from scratch: apply the fix, then run the rollback suite so the
  new up/down pair is verified.
- **Add the failing scenario to the test suite.** If the failure was a
  constraint-name collision, partition edge case, or a pre-existing object, a
  regression test in `tests/migrations/integration/` should cover it.
- **Review every hand-run SQL against production.** Anything applied outside
  the chain must be converted into a migration so the chain stays the single
  source of truth.
- **Update this runbook** if the failure mode was new.
- **Related:** [02 Database index bloat](./02-database-index-bloat.md),
  [07 DB connection pool exhaustion](./07-db-pool-exhaustion.md),
  [09 Ledger imbalance](./09-ledger-imbalance.md).
