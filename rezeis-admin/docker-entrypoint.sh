#!/bin/sh
set -e

# ──────────────────────────────────────────────────────────────────────────────
# rezeis-admin entrypoint
#
# Runs once per container start:
#   1. Wait for the database to be reachable (Prisma will fail otherwise).
#   2. If we're the API role (default), run `prisma migrate deploy`.
#      Workers (RUID_PROCESS_ROLE=worker) skip migrations — they must never
#      race the API on schema changes; only one process should apply DDL.
#   3. Exec the requested command (CMD or `docker compose run` arg).
#
# Migration skip:
#   Set RUID_SKIP_MIGRATIONS=true to disable auto-migration entirely
#   (useful for restoring backups, debugging, or running ad-hoc shells).
# ──────────────────────────────────────────────────────────────────────────────

PROCESS_ROLE="${RUID_PROCESS_ROLE:-api}"
SKIP_MIGRATIONS="${RUID_SKIP_MIGRATIONS:-false}"
APP_USER="rezeis"
APP_UID="1001"

echo "[entrypoint] role=${PROCESS_ROLE} skip-migrations=${SKIP_MIGRATIONS}"

# When started as root, ensure the persistent data volume is writable by the
# unprivileged app user. Named/host volumes mounted over /app/data can be
# root-owned (e.g. created before the image switched to a non-root user),
# which silently breaks backups, uploads, and the disk health check. Repair
# once (only when the top dir is mis-owned) so subsequent starts stay fast.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data/backups /app/data/uploads
  if [ "$(stat -c %u /app/data 2>/dev/null)" != "${APP_UID}" ]; then
    echo "[entrypoint] repairing /app/data ownership → ${APP_USER}"
    chown -R "${APP_USER}:${APP_USER}" /app/data
  fi
fi

# Worker doesn't run migrations.
if [ "${PROCESS_ROLE}" != "worker" ] && [ "${SKIP_MIGRATIONS}" != "true" ]; then
  echo "[entrypoint] applying pending Prisma migrations…"

  # Brief retry loop in case Postgres is still warming up. Compose health-checks
  # already gate startup, but this protects against external/managed DBs that
  # depends_on can't health-check.
  attempt=0
  max_attempts=30
  until npx prisma migrate deploy 2>&1; do
    status=$?
    attempt=$((attempt + 1))
    if [ "${attempt}" -ge "${max_attempts}" ]; then
      echo "[entrypoint] FATAL: migrate deploy failed after ${attempt} attempts (last exit ${status})"
      exit "${status}"
    fi
    echo "[entrypoint] migrate deploy failed (exit ${status}), retrying in 2s (attempt ${attempt}/${max_attempts})…"
    sleep 2
  done

  echo "[entrypoint] migrations up-to-date"
else
  echo "[entrypoint] skipping migrations"
fi

# Hand off to the requested process, dropping root privileges to the app user
# if we started as root. `exec` so signals (SIGTERM from compose stop) reach
# the Node process and graceful shutdown actually fires.
if [ "$(id -u)" = "0" ]; then
  exec su-exec "${APP_USER}:${APP_USER}" "$@"
else
  exec "$@"
fi
