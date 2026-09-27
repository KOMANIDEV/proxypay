# One-Click Deployment (Heroku & Google Cloud Run)

This document describes how to deploy ProxyPay to Heroku or Google Cloud Run
with a one-click / minimal-command flow (Issue #418).

## What's included

| Artifact | Purpose |
| --- | --- |
| `app.json` | Heroku one-click "Deploy to Heroku" configuration |
| `cloudbuild.yaml` | Cloud Build configuration (build + push + Cloud Run deploy) |
| `cloud-run/service.yaml` | Declarative Cloud Run service manifest |
| `scripts/deploy/setup-env.js` | Environment variable setup automation (secret generation) |
| `scripts/deploy/verify-deployment.sh` | Post-deployment verification checks |
| `scripts/deploy/deploy-heroku.sh` | Heroku CLI deploy helper |
| `scripts/deploy/deploy-cloud-run.sh` | Cloud Run CLI deploy helper |

The app ships with a production `Dockerfile` (`node:20-alpine`, `EXPOSE 3000`,
`node dist/index.js`) that all of the flows below rely on.

## Prerequisites (app level)

Regardless of platform you must provision three backing services and provide
their connection details as environment variables:

- **PostgreSQL** → `DATABASE_URL`
- **Redis** → `REDIS_URL`
- **Stellar issuer account** → `STELLAR_ISSUER_SECRET`

These are validated at startup (`src/config/env.ts`), so a deployment without
them will not become ready.

> `setup-env.js` auto-generates strong random values for the secret fields in
> `.env.example`. Long-lived credentials such as `STELLAR_ISSUER_SECRET`/`MTN_*`
> /`AIRTEL_*` must be replaced with real values after provisioning.

---

## Heroku

### Option A — One-click (recommended)

1. Add `app.json` (already present in the repo).
2. Open the repository on GitHub and click **Deploy to Heroku**.
3. Give the app a name; `app.json` automatically:
   - provisions `heroku-postgresql` and `heroku-redis`,
   - runs `npm run migrate:up` as the **postdeploy** script,
   - applies the declared environment variables (generated secrets for
     `JWT_SECRET`, `OAUTH_JWT_SECRET`, `DB_ENCRYPTION_KEY`, `PII_MASTER_KEY`,
     `ADMIN_API_KEY`, etc.),
   - wires `DATABASE_URL` and `REDIS_URL` to the provisioned addons.
4. After deployment, replace `STELLAR_ISSUER_SECRET`, `STELLAR_SIGNING_KEY`
   and provider secrets with real values, then restart:

   ```bash
   heroku config:set STELLAR_ISSUER_SECRET="S..." --app your-app
   heroku restart --app your-app
   ```

### Option B — CLI

```bash
STELLAR_ISSUER_SECRET="S..." ./scripts/deploy/deploy-heroku.sh your-app-name
```

The helper creates the app, provisions Postgres + Redis addons, applies the
environment variables produced by `setup-env.js`, pushes to Heroku, and prints
the verification command.

Heroku uses a **container** stack by default (the `Dockerfile`). For the
standard Node.js buildpack instead, set `STACK=heroku-22`.

---

## Google Cloud Run

### Option A — Cloud Console one-click

1. Confirm the following are enabled for the project: Cloud Run, Cloud Build,
   Artifact Registry.
2. Create a PostgreSQL database (e.g. Cloud SQL) and a Redis instance reachable
   from Cloud Run (same VPC / private network).
3. Trigger a build with `cloudbuild.yaml`, or configure a Cloud Build trigger on
   the source repository.

### Option B — CLI

```bash
PROJECT_ID=my-gcp-project \
DATABASE_URL="postgresql://user:pass@host:5432/proxypay" \
REDIS_URL="redis://host:6379" \
STELLAR_ISSUER_SECRET="S..." \
./scripts/deploy/deploy-cloud-run.sh
```

The helper generates environment variables and runs:

```bash
gcloud builds submit --config cloudbuild.yaml --project "$PROJECT_ID"
```

`cloudbuild.yaml` builds and pushes the image to Artifact Registry and deploys
to managed Cloud Run on port `3000`. `cloud-run/service.yaml` is the
declarative equivalent and wires readiness (`/ready`) and startup (`/health`)
probes plus secret references.

---

## Environment variable setup automation

`scripts/deploy/setup-env.js` reads `.env.example`, deduplicates keys, and
replaces placeholder/secret values with freshly generated random secrets.

```bash
# Write a populated ./.env (with generated secrets)
node scripts/deploy/setup-env.js

# Print a block for pasting into Heroku config / Cloud Run env
node scripts/deploy/setup-env.js --print heroku
node scripts/deploy/setup-env.js --print cloudrun
```

Set the platform-managed connection strings (`DATABASE_URL`, `REDIS_URL`) and
any long-lived provider secrets after generation.

---

## Post-deployment verification

`scripts/deploy/verify-deployment.sh` exercises the app's built-in endpoints
against a live deployment:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness / status |
| `GET /ready` | Readiness (database + redis + shutdown state) |
| `GET /health/lb` | Load balancer health |

```bash
./scripts/deploy/verify-deployment.sh https://your-app.example.com

# Optional: tune the wait
VERIFY_TIMEOUT=300 VERIFY_INTERVAL=10 ./scripts/deploy/verify-deployment.sh https://...
```

It polls each endpoint until it returns HTTP `200`, then confirms the payload
reports a healthy database and redis. Exit code `0` = pass, `1` = fail.

---

## Migrations

Migrations run automatically on Heroku via the `postdeploy` script
(`npm run migrate:up`). For Cloud Run, run them once against the target
database before or during rollout:

```bash
npm run migrate:up
```

See `docs/MIGRATION_TESTING.md` for the migration workflow and safety checks.
