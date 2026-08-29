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
PRISMA="./node_modules/.bin/prisma"

# Migrations whose every statement is guarded by IF NOT EXISTS / IF EXISTS, so a
# half-applied one can simply be re-run. Membership is what decides between "the
# next start retries it" and "the API refuses to boot until a human runs
# `prisma migrate resolve`" — and Prisma migrations are NOT atomic: an
# interrupted file leaves its earlier statements committed and the row marked
# `finished=false`. Verified by interrupting one on purpose.
#
# ADDING TO THIS LIST IS NOT AUTOMATIC. A migration belongs here only if running
# it twice is provably harmless. The two panel-identity entries were checked that
# way — applied, then applied again on the same database, second run clean with
# nothing but `NOTICE ... already exists, skipping`.
#
# THE AUGUST ENTRIES BELOW WERE CHECKED THE SAME WAY, and adding them closes a
# gap that had been widening for three releases. Every one of them is guarded
# throughout and says so in its own header — but writing "replay-safe" at the top
# of a file does nothing on its own. Membership here is the only thing that turns
# that property into a retry instead of a refusal to boot.
#
# What the gap actually cost: these files add foreign keys to `users`, which need
# a brief SHARE ROW EXCLUSIVE lock. The hourly `pg_dump` holds ACCESS SHARE on
# every table, so the FK queues behind it and `lock_timeout = '5s'` fires — which
# is the bound doing its job. Prisma is not transactional per file, so the tables
# and indexes are already committed and the row is left `finished=false`. Without
# membership the next start hits P3009, refuses, and the panel stays down until a
# human runs `prisma migrate resolve` — for a file that would have replayed
# cleanly on its own.
is_auto_recoverable_migration() {
  case "$1" in
    20260708120000_perf_composite_indexes|20260724120000_reconcile_subscription_expiry_index|20260724120500_drop_conflicting_subscription_expiry_index|20260724121000_swap_subscription_expiry_index|20260810120000_remnawave_panel_identity|20260810160000_index_subscription_panel_identity)
      return 0
      ;;
    20260823120000_partner_level_accrual_strategy|20260828120000_blocked_identities|20260828160000_blocklist_cascade|20260828180000_device_observations|20260828200000_legal_privacy_policy)
      return 0
      ;;
    20260829120000_user_hints|20260829150000_guest_support_device|20260829170000_user_ip_observations)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

cleanup_retry_artifacts() {
  case "$1" in
    20260724120000_reconcile_subscription_expiry_index)
      echo "[entrypoint] removing a possibly incomplete subscription expiry staging index"
      if ! printf '%s\n' \
        'DROP INDEX CONCURRENTLY IF EXISTS "public"."subscriptions_status_expires_at_rebuild_idx";' \
        | "${PRISMA}" db execute --stdin 2>&1; then
        echo "[entrypoint] FATAL: failed to remove the subscription expiry staging index"
        return 1
      fi
      ;;
  esac
}

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
  #
  # P3009 auto-recovery is deliberately allow-listed. PostgreSQL migrations are
  # not guaranteed to be transactional, so marking an arbitrary failed
  # migration rolled back can replay partially applied DDL. Only explicitly
  # retry-safe index migrations may be resolved automatically; every
  # other failed migration stops for operator review.
  attempt=0
  max_attempts=30
  resolved_migration=""
  while true; do
    if deploy_output="$("${PRISMA}" migrate deploy 2>&1)"; then
      status=0
    else
      status=$?
    fi
    echo "${deploy_output}"
    if [ "${status}" -eq 0 ]; then
      break
    fi

    if echo "${deploy_output}" | grep -q "P3009"; then
      failed_migration="$(echo "${deploy_output}" | grep -oE '[0-9]{14}_[A-Za-z0-9_]+' | head -n 1)"
      if [ -z "${failed_migration}" ]; then
        echo "[entrypoint] FATAL: P3009 did not include a parseable migration name; manual recovery required"
        exit "${status}"
      fi
      if ! is_auto_recoverable_migration "${failed_migration}"; then
        echo "[entrypoint] FATAL: migration ${failed_migration} is not safe to auto-resolve; manual recovery required"
        exit "${status}"
      fi
      if [ "${failed_migration}" != "${resolved_migration}" ]; then
        if ! cleanup_retry_artifacts "${failed_migration}"; then
          exit "${status}"
        fi
        echo "[entrypoint] failed migration detected (P3009): ${failed_migration} — marking rolled-back so it can be re-applied"
        if ! "${PRISMA}" migrate resolve --rolled-back "${failed_migration}" 2>&1; then
          echo "[entrypoint] FATAL: failed to mark ${failed_migration} rolled back"
          exit "${status}"
        fi
        resolved_migration="${failed_migration}"
        continue
      fi
      echo "[entrypoint] FATAL: ${failed_migration} failed again after one safe recovery attempt"
      exit "${status}"
    fi

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
