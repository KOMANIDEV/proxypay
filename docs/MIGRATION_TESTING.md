# Migration Testing & Rollback Safety

How ProxyPay validates database migrations **before** they touch a production
database, verifies them on a scratch database in CI, and recovers when a
migration fails mid-flight.

Every migration ships as a pair of SQL files in `migrations/`:

```
migrations/
├── 20260826_add_user_avatar.sql      # the "up" migration
└── 20260826_add_user_avatar.down.sql # its rollback
```

The rollback file is **mandatory**: `migrate:up` refuses to apply any pending
migration that has no `.down.sql` companion (pre-flight rollback-safety check).
This is the first line of defence against the "irreversible migration" failure
mode that corrupts data.

---

## The testing layers

| Layer                  | Command                    | What it catches                                                                     | Where it runs                                   |
| ---------------------- | -------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1. Static validation   | `npm run migrate:validate` | Broken/empty files, missing rollbacks, irreversible statements, naming violations   | CI + pre-flight (automatic before `migrate:up`) |
| 2. Impact analysis     | `npm run migrate:analyze`  | Cross-migration hazards: duplicate creates, orphan drops, data-modifying migrations | CI (advisory)                                   |
| 3. Dry-run             | `npm run migrate:dry-run`  | SQL that does not actually run against a real Postgres                              | CI (fresh DB)                                   |
| 4. Up/down integration | `npm run test:migrations`  | Each migration applies for real and its rollback restores the exact previous schema | CI (fresh DB)                                   |

---

## 1. Static validation (`migrate:validate`)

Runs before any SQL is executed. It operates purely on the files on disk, so it
is cheap and side-effect free. Errors block a migration run; warnings report
risk without blocking.

```bash
npm run migrate:validate
```

Checks:

- **`EMPTY_MIGRATION` / `EMPTY_ROLLBACK`** (error) — file contains no statements
  (only comments). An up migration that changes nothing records a version with
  no effect; a rollback that changes nothing silently "succeeds".
- **`UNTERMINATED_SQL`** (error) — unterminated quote or comment; the file
  would fail at runtime.
- **`UNREADABLE_FILE`** (error) — cannot read the file.
- **`DUPLICATE_VERSION`** (error) — two migration files share a version number.
- **`DESTRUCTIVE_STATEMENT`** (warning, error if no rollback file) — the up
  migration contains `DROP TABLE/COLUMN/INDEX/CONSTRAINT`, `TRUNCATE`,
  `DELETE`, or `UPDATE`. Irreversible or risky; needs a rollback file and a
  reviewer.
- **`MISSING_ROLLBACK_FILE`** (warning) — no `.down.sql` exists. Rollback
  testing skips the migration and `migrate:up` will refuse to apply it.
- **`NON_CONFORMING_FILENAME`** (warning) — a `.sql` file in `migrations/`
  that does not match `<NNN>_<description>.sql` and is silently ignored by the
  runner.

`migrate:up` runs the same validation automatically and **throws** before
touching the database if any error is present.

## 2. Impact analysis (`migrate:analyze`)

Statically parses each migration and reports which database objects it
creates, alters, or drops, plus any data-modifying statements. It then
compares migrations against each other to surface hazards:

```bash
npm run migrate:analyze          # human-readable report
npm run migrate:analyze -- --json  # machine-readable (CI/scripts)
```

Findings:

- **`DUPLICATE_OBJECT_CREATE`** (warning) — the same object is created by two
  different migrations. Usually a guarded `IF NOT EXISTS` no-op, but worth
  confirming the definitions agree.
- **`ORPHAN_DROP`** (warning) — a migration drops an object no earlier
  migration creates. It may target a table created by an unmanaged script —
  the rollback can destroy something the migration chain does not own.
- **`DATA_MODIFYING`** (warning) — a migration runs `INSERT`/`UPDATE`/
  `DELETE`/`TRUNCATE`. Data changes are irreversible once rows change; the
  rollback file must restore them.
- **`REPEATED_CREATE` / `REFERENTIAL_DROP`** (info) — informational.

The analysis is heuristic (it reads SQL text, it does not execute it). Layer 3
is the source of truth for "does this SQL actually run".

## 3. Dry-run (`migrate:dry-run`)

Executes every pending migration against a real PostgreSQL inside a **single
transaction that is rolled back**. Nothing persists — no tables, no rows, no
`schema_migrations` entries — but Postgres fully parses and executes the SQL,
so syntax errors, missing objects, constraint violations at DDL time, and
ordering problems all surface.

```bash
npm run migrate:dry-run
```

Running the whole pending chain in one transaction (rather than one
transaction per migration) is deliberate: migration N+1 is verified against
the schema state migration N actually produces, which is the state it will see
in production.

## 4. Integration & rollback testing (`test:migrations`)

The heavyweight layer. Requires a reachable PostgreSQL at `DATABASE_URL`
(docker-compose provides one; see `docker-compose.yml`). It is a separate
Jest suite because it executes real DDL:

```bash
npm run test:migrations
```

The suite (`tests/migrations/integration/runner.integration.test.ts`) runs
against a scratch schema and covers:

1. **Full-chain dry-run** — the whole migration set applies without persisting.
2. **Full up** — every migration applies for real; `schema_migrations` records
   all 77 versions.
3. **Status / idempotency** — `status` reports all applied; a second `up` is a
   no-op.
4. **`down` behaviour** — rolling back the last migration removes its version
   and re-applying restores the chain.
5. **Static validation** — the real migration set passes validation.
6. **Per-migration rollback verification** — for **each** migration, in order:
   apply everything before it, snapshot the schema (columns, constraints,
   indexes, sequences, enums, functions, triggers), apply the migration, run
   its `.down.sql`, and assert the schema is **byte-for-byte identical** to the
   snapshot. Any leftover object, dropped pre-existing object, renamed
   constraint, or type drift fails the suite.

The rollback suite is what made the migration set production-safe: it caught
partition leftovers, orphaned indexes, constraint-name drift, and down files
that dropped columns a _previous_ migration had created.

---

## Adding a new migration

```bash
npm run migrate:create add_user_avatar
# creates migrations/20260826_add_user_avatar.sql
#      and migrations/20260826_add_user_avatar.down.sql
```

Rules:

1. **Always write the `.down.sql`** — `migrate:up` refuses to run without it.
   The rollback must restore the _exact_ previous schema (the rollback suite
   enforces this).
2. **Never drop objects you did not create.** If the migration is a guarded
   no-op (the object already exists), the rollback must also be a no-op guard
   that _asserts_ the object still exists — a comment-only rollback file fails
   validation.
3. **Prefer additive changes.** `ADD COLUMN`/`CREATE INDEX` roll back cleanly.
   Type changes, data backfills, and drops need extra care.
4. **Keep it in one transaction.** The runner wraps each migration in a
   transaction; a failing migration rolls back completely, with no partial
   schema and no version recorded. Do not add your own `BEGIN`/`COMMIT`.
5. **Run the local checks before pushing:**
   ```bash
   npm run migrate:validate
   npm run migrate:analyze
   docker compose up -d db   # or your local Postgres
   npm run migrate:dry-run
   npm run test:migrations
   ```

---

## CI wiring

`.github/workflows/ci.yml` runs migrations against a fresh Postgres service
container:

- `npm run migrate:validate` — static checks (fail fast).
- `npm run migrate:up` — applies the full chain for real (fails the build on
  any migration that cannot run).
- `npm run test:migrations` — dry-run, up/down, and the per-migration rollback
  suite.

If CI's migrate step fails, no deploy happens — a migration that cannot apply
on a fresh database cannot be trusted on production.

---

## When production is already ahead

If a migration was already applied manually or a version exists in
`schema_migrations` without a file, the runner's legacy-version normalisation
(`normalizeLegacyAppliedVersions`) reconciles numeric-only entries with their
full version identifiers so status/up/down stay consistent. Applied versions
are never re-applied.

---

## Related

- **Failure recovery:** [Runbook 11 — Migration failure](./runbooks/11-migration-failure.md)
- **Backups:** [`docs/DATABASE_BACKUPS.md`](./DATABASE_BACKUPS.md)
- **Deployment & rollback:** [`docs/BRIDGE_DEPLOYMENT_RUNBOOK.md`](./BRIDGE_DEPLOYMENT_RUNBOOK.md)
