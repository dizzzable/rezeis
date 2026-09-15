-- Who asked for a plan migration item's current attempt.
--
-- A run is created by one operator and can be retried by another: operator B
-- opens the delete dialog, attaches to operator A's run and presses «Повторить
-- для неудавшихся». The moves that retry causes are B's decision, so their audit
-- rows must name B, B's address and B's client — until now every row named the
-- run's creator, and B's action left no trace at all.
--
-- Per item rather than per run: a retry reopens only the FAILED items, and the
-- items of the same run that were still PENDING remain A's. NULL on all four
-- columns means "the run's creator", so a run nobody retried stores nothing
-- twice.
--
-- A separate file rather than an edit of 20260915120000_plan_migration_runs:
-- Prisma checksums applied migrations, and a database that already holds that
-- one must be able to take this one. Nullable columns with no default on a table
-- that starts empty: a catalogue change, no rewrite. `IF NOT EXISTS` so a
-- partially applied run replays.
ALTER TABLE "plan_migration_items" ADD COLUMN IF NOT EXISTS "actor_admin_id" TEXT;
ALTER TABLE "plan_migration_items" ADD COLUMN IF NOT EXISTS "actor_request_id" TEXT;
ALTER TABLE "plan_migration_items" ADD COLUMN IF NOT EXISTS "actor_ip_address" TEXT;
ALTER TABLE "plan_migration_items" ADD COLUMN IF NOT EXISTS "actor_user_agent" TEXT;
