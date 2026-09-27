#!/usr/bin/env bash
#
# Google Cloud Run one-click deploy helper for proxypay (Issue #418).
#
# Wraps the full flow: generate environment variables, build & push the image
# via Cloud Build, deploy to Cloud Run, then run post-deployment verification.
#
# Prerequisites:
#   * gcloud CLI installed and authenticated  (gcloud auth login)
#   * a project with Cloud Run, Artifact Registry, and Cloud Build enabled
#   * a PostgreSQL database (e.g. Cloud SQL) reachable by the service
#   * a Redis instance reachable by the service
#
# Usage:
#   PROJECT_ID=my-gcp-project \
#   DB_INSTANCE=my-project:us-central1:my-db \
#   DATABASE_URL="postgresql://user:pass@db-host:5432/proxypay" \
#   REDIS_URL="redis://redis-host:6379" \
#   STELLAR_ISSUER_SECRET="S..." \
#   ./scripts/deploy/deploy-cloud-run.sh
#
# Optional env:
#   SERVICE_NAME   Cloud Run service name  (default: proxypay)
#   REGION         GCP region              (default: us-central1)

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-proxypay}"
REGION="${REGION:-us-central1}"

if [ -z "${PROJECT_ID:-}" ]; then
  echo "PROJECT_ID is required" >&2
  exit 1
fi

echo "==> Generating environment variables"
# Generate a ready .env with fresh secrets from .env.example.
node "$(dirname "$0")/setup-env.js" || true

echo "==> Deploying ${SERVICE_NAME} in ${REGION}"
gcloud builds submit \
  --config cloudbuild.yaml \
  --project "${PROJECT_ID}" \
  --substitutions "_SERVICE_NAME=${SERVICE_NAME},_REGION=${REGION}"

echo "==> Deployed. Run post-deployment verification:"
URL="https://${SERVICE_NAME}-$(tr ':' '-' <<<"${PROJECT_ID}").${REGION}.run.app"
echo "    ./scripts/deploy/verify-deployment.sh \"${URL}\""
