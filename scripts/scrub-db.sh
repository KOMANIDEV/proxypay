#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status,
# treat unset variables as an error, and fail pipelines if any command fails.
set -euo pipefail

echo "=================================================="
echo "🛡️  Starting Nightly Data Scrub Pipeline"
echo "=================================================="

# 1. Validate Environment Variables
if [ -z "${PROD_DB_URL:-}" ] || [ -z "${STAGING_DB_URL:-}" ]; then
    echo "❌ ERROR: PROD_DB_URL and STAGING_DB_URL must be set."
    echo "Usage: PROD_DB_URL=... STAGING_DB_URL=... ./scrub-db.sh"
    exit 1
fi

TEMP_DB_NAME="scrub_temp_$(date +%s)"
# Extract connection string without the DB name for the temp DB creation
LOCAL_PG_URL="postgresql://postgres:postgres@localhost:5432"

echo "📦 Step 1: Creating ephemeral scrubbing database ($TEMP_DB_NAME)..."
psql "$LOCAL_PG_URL/postgres" -c "CREATE DATABASE $TEMP_DB_NAME;" > /dev/null

echo "⬇️  Step 2: Dumping PROD and restoring to ephemeral database..."
# Use pg_dump to pull data and pipe it directly into the temp database
pg_dump "$PROD_DB_URL" --no-owner --no-acl | psql "$LOCAL_PG_URL/$TEMP_DB_NAME" > /dev/null

echo "🧹 Step 3: Scrubbing PII and financial data..."
# Run the UPDATE scripts to replace sensitive data with faker/anonymized data
psql "$LOCAL_PG_URL/$TEMP_DB_NAME" << 'EOF'
    BEGIN;

    -- 1. Mask User PII
    -- Replaces names with generic strings, emails with safe staging domains, and phones with fake numbers
    UPDATE users
    SET
        first_name = 'TestUser_' || id,
        last_name  = 'Scrubbed',
        email      = 'user_' || id || '@staging.local',
        phone      = '+1555' || LPAD(id::text, 7, '0'),
        password_hash = 'scrypt:masked', -- Invalidate real passwords
        kyc_status = 'verified';

    -- 2. Scramble Financial Balances
    -- Sets random plausible balances between 10.00 and 5000.00
    UPDATE wallets
    SET
        balance = trunc(random() * 5000 + 10)::numeric;

    -- 3. Mask Transaction Metadata (Optional but recommended)
    UPDATE transactions
    SET
        reference_note = 'Scrubbed transaction note';

    COMMIT;
EOF

echo "⬆️  Step 4: Pushing sanitized data to STAGING..."
# Dump the scrubbed temp DB and pipe it directly into the Staging DB
pg_dump "$LOCAL_PG_URL/$TEMP_DB_NAME" --clean --no-owner | psql "$STAGING_DB_URL" > /dev/null

echo "🗑️  Step 5: Cleaning up ephemeral database..."
psql "$LOCAL_PG_URL/postgres" -c "DROP DATABASE $TEMP_DB_NAME;" > /dev/null

echo "✅ Success: Staging environment has been refreshed with secure, scrubbed data!"