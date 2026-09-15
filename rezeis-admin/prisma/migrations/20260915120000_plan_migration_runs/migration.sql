-- Moving subscriptions off a plan before it is deleted (15.09.2026).
--
-- The delete dialog lists the subscriptions still on a plan and lets the
-- operator move them to other plans first. A move is one transaction per
-- subscription, run by a worker in small batches, so the request that starts
-- it answers at once and the dialog polls a RUN for progress. These two tables
-- are that run and its per-subscription outcome.
--
-- NO FOREIGN KEYS OUTSIDE THE PAIR. `source_plan_id`, `from_plan_id` and
-- `to_plan_id` name plans the nightly sweep may hard-delete later, and
-- `subscription_id` names a row the run only reports on. A run is history; it
-- must never keep a plan or a subscription alive, nor vanish with one.
--
-- `plan_migration_items (subscription_id, from_plan_id, status, moved_at)` is
-- the lookup the payment fulfilment makes under the subscription lock: a
-- renewal for the OLD plan that was created before the move and completes
-- after it must extend the subscription on the plan it is on now. `moved_at`
-- is written in the same transaction as the move, so it is the move's commit.
--
-- ONE OPEN RUN PER PLAN. The partial unique index is the database's half of
-- `409 MIGRATION_ALREADY_RUNNING`; the service checks first under the plan's
-- row lock and this refuses the insert if two requests ever get past that.
-- Prisma cannot express a WHERE clause, so the index lives only here.
--
-- Nothing is live: both tables start empty and nothing reads them until an
-- operator starts a run. No `lock_timeout` is set because no existing table is
-- touched. `updated_at` carries no default, like every other table here — the
-- client supplies it (`20260903120000_wheel_updated_at_defaults`). Every
-- statement is guarded, so a partial application replays cleanly.

-- == ENUMS ===================================================================

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlanMigrationRunStatus') THEN
    CREATE TYPE "PlanMigrationRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlanMigrationItemStatus') THEN
    CREATE TYPE "PlanMigrationItemStatus" AS ENUM ('PENDING', 'MOVED', 'SKIPPED', 'FAILED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlanMigrationItemOrigin') THEN
    CREATE TYPE "PlanMigrationItemOrigin" AS ENUM ('GROUP', 'REST', 'SHARED_PROFILE');
  END IF;
END
$do$;

-- == RUNS ====================================================================

CREATE TABLE IF NOT EXISTS "plan_migration_runs" (
  "id"                  TEXT NOT NULL,
  "source_plan_id"      TEXT NOT NULL,
  "status"              "PlanMigrationRunStatus" NOT NULL DEFAULT 'QUEUED',
  "created_by_admin_id" TEXT,
  "request_id"          TEXT,
  "ip_address"          TEXT,
  "user_agent"          TEXT,
  "total_items"         INTEGER NOT NULL DEFAULT 0,
  "started_at"          TIMESTAMPTZ(3),
  "finished_at"         TIMESTAMPTZ(3),
  "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "plan_migration_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "plan_migration_runs_source_plan_id_created_at_idx"
  ON "plan_migration_runs" ("source_plan_id", "created_at");
-- The restart sweep's read: runs still QUEUED or RUNNING.
CREATE INDEX IF NOT EXISTS "plan_migration_runs_status_idx"
  ON "plan_migration_runs" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "plan_migration_runs_open_source_plan_key"
  ON "plan_migration_runs" ("source_plan_id")
  WHERE "status" IN ('QUEUED', 'RUNNING');

-- == ITEMS ===================================================================

CREATE TABLE IF NOT EXISTS "plan_migration_items" (
  "id"              TEXT NOT NULL,
  "run_id"          TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "from_plan_id"    TEXT NOT NULL,
  "to_plan_id"      TEXT NOT NULL,
  "status"          "PlanMigrationItemStatus" NOT NULL DEFAULT 'PENDING',
  "origin"          "PlanMigrationItemOrigin" NOT NULL DEFAULT 'GROUP',
  "reason"          TEXT,
  "detail"          TEXT,
  "sync_job_id"     TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "moved_at"        TIMESTAMPTZ(3),
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "plan_migration_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "plan_migration_items_run_id_subscription_id_key"
  ON "plan_migration_items" ("run_id", "subscription_id");
-- Payment fulfilment's guard lookup (see the header).
CREATE INDEX IF NOT EXISTS "plan_migration_items_guard_lookup_idx"
  ON "plan_migration_items" ("subscription_id", "from_plan_id", "status", "moved_at");
-- The worker's batch read and the progress counts.
CREATE INDEX IF NOT EXISTS "plan_migration_items_run_id_status_idx"
  ON "plan_migration_items" ("run_id", "status");

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_migration_items_run_id_fkey') THEN
    ALTER TABLE "plan_migration_items"
      ADD CONSTRAINT "plan_migration_items_run_id_fkey"
      FOREIGN KEY ("run_id") REFERENCES "plan_migration_runs"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;
