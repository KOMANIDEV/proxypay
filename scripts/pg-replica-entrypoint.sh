#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Postgres streaming-replica entrypoint (local development / docker-compose)
#
# Boots a postgres:16-alpine container as a hot-standby streaming replica of a
# primary. On first start (empty PGDATA) it clones the primary with
# pg_basebackup (-R writes primary_conninfo into postgresql.auto.conf) and then
# hands off to the official docker-entrypoint.sh, which starts the standby.
#
# Required env (set by docker-compose):
#   PRIMARY_HOST     hostname of the primary postgres container
#   REPLICA_USER     superuser on the primary (used for base backup)
#   PGPASSWORD       password for REPLICA_USER
#
# NOTE: no replication slot is created, so the replica can fall behind and need
# a re-clone if the primary recycles WAL (fine for dev; production uses RDS).
# ─────────────────────────────────────────────────────────────────────────────

set -e

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[postgres-replica] PGDATA is empty — cloning primary at ${PRIMARY_HOST} via pg_basebackup..."
  rm -rf "$PGDATA"
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  pg_basebackup \
    -h "$PRIMARY_HOST" \
    -U "${REPLICA_USER:-postgres}" \
    -D "$PGDATA" \
    -R \
    -P \
    --wal-method=stream
  chown -R postgres:postgres "$PGDATA"
  echo "[postgres-replica] Base backup complete. Starting as hot standby."
fi

exec docker-entrypoint.sh "$@"
