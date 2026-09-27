#!/usr/bin/env bash
#
# Post-deployment verification checks for proxypay (Issue #418).
#
# Verifies a freshly deployed instance is healthy by exercising the app's
# built-in endpoints:
#   GET /health   - liveness / status heartbeats
#   GET /ready    - readiness (DB + Redis + shutdown state)
#   GET /health/lb- load balancer health
#
# Usage:
#   ./scripts/deploy/verify-deployment.sh https://my-app.example.com
#   VERIFY_TIMEOUT=300 ./scripts/deploy/verify-deployment.sh <URL>
#
# Exits 0 when all checks pass, 1 otherwise.

set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <base-url>        e.g. $0 https://my-app.example.com" >&2
  exit 1
fi

# Normalize: strip trailing slash
BASE_URL="${BASE_URL%/}"

TOTAL_TIMEOUT="${VERIFY_TIMEOUT:-300}"   # seconds
INTERVAL="${VERIFY_INTERVAL:-10}"        # seconds
FAILURES=0

echo "==> Post-deployment verification for ${BASE_URL}"
echo "    timeout: ${TOTAL_TIMEOUT}s, interval: ${INTERVAL}s"

fail() {
  echo "FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}

ok() {
  echo "ok:   $1"
}

wait_for_http_200() {
  local url="$1"
  local label="$2"
  local elapsed=0
  while [ "$elapsed" -lt "$TOTAL_TIMEOUT" ]; do
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url" || echo "000")
    if [ "$status" = "200" ]; then
      ok "${label} returned HTTP 200"
      return 0
    fi
    echo "      ${label} -> HTTP ${status} after ${elapsed}s (waiting)"
    sleep "$INTERVAL"
    elapsed=$((elapsed + INTERVAL))
  done
  fail "${label} never returned HTTP 200 within ${TOTAL_TIMEOUT}s"
  return 1
}

echo "==> [1/3] Liveness (GET /health)"
if wait_for_http_200 "${BASE_URL}/health" "/health"; then
  health_body=$(curl -s "${BASE_URL}/health" || true)
  echo "$health_body" | grep -q '"status":"ok"' && ok "/health reports status ok" \
    || fail "/health did not report a healthy status"
fi

echo "==> [2/3] Readiness (GET /ready)"
if wait_for_http_200 "${BASE_URL}/ready" "/ready"; then
  ready_body=$(curl -s "${BASE_URL}/ready" || true)
  echo "$ready_body" | grep -q '"database":"ok"' && ok "database is ready" \
    || fail "database not ready"
  echo "$ready_body" | grep -q '"redis":"ok"' && ok "redis is ready" \
    || fail "redis not ready (may be expected if redis is down)"
fi

echo "==> [3/3] Load balancer health (GET /health/lb)"
if wait_for_http_200 "${BASE_URL}/health/lb" "/health/lb"; then
  ok "/health/lb returned HTTP 200"
fi

echo ""
echo "==> Verification complete"

if [ "$FAILURES" -eq 0 ]; then
  echo "RESULT: PASS - ${BASE_URL} is healthy"
  exit 0
else
  echo "RESULT: FAIL - ${FAILURES} check(s) failed" >&2
  exit 1
fi
