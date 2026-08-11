-- Records the panel's numeric user id and the username a profile was created
-- under, so one build can drive Remnawave 2.7.4, 2.8.0 and 3.2.1.
--
-- WHY 3.x NEEDS THIS: 3.0 dropped the `uuid` column from the panel's users
-- table and re-keyed every user-scoped route on the numeric `id`. The old uuid
-- is not preserved anywhere on upgrade (verified by running a real 2.8.1 ->
-- 3.2.1 migration and searching every text/uuid column afterwards), so a
-- subscription whose `remnawave_id` holds a 2.x uuid has no way back to its
-- profile on a 3.x panel except by name.
--
-- Both columns are nullable and are filled opportunistically: the numeric id
-- whenever any panel row is read (2.x rows carry `id` too, so this backfills
-- itself long before anybody upgrades), the username when a profile is created
-- or linked. Nothing here rewrites `remnawave_id` — ~14 call sites read its
-- null-ness as "no profile yet, CREATE one", and changing it in a migration
-- would be the one edit that can duplicate live profiles.
--
-- WHY THIS RUNS ON LIVE DATA WITHOUT A REHEARSAL: migrations in this repo are
-- never executed in CI, so this is additive only. `ADD COLUMN` with no default
-- and no NOT NULL takes a brief ACCESS EXCLUSIVE lock and rewrites no rows on
-- PostgreSQL 11+. Measured on a populated copy: 3 ms, `relfilenode` unchanged.
-- (No index here: 20260810160000 adds them, once these columns became lookup
-- keys — the original claim that they never would was overtaken by the webhook.)
--
-- THE THREE MILLISECONDS ARE NOT THE RISK. Acquiring ACCESS EXCLUSIVE is
-- unbounded: it queues behind every open transaction on the table, and once it
-- is queued every later reader queues behind IT. The hourly `pg_dump` cron holds
-- ACCESS SHARE on all tables for the length of the dump, which is exactly long
-- enough to turn a 3 ms change into a full stall — and with the Prisma pool at
-- its default size, stalled connections exhaust it and unrelated endpoints start
-- answering P2024. Reproduced.
--
-- So: wait five seconds for the lock, then fail. A failed migration is
-- recoverable — this file is idempotent and listed in
-- `is_auto_recoverable_migration`, so the next start retries it — whereas a
-- queued one is an outage with no timeout on it.
SET lock_timeout = '5s';

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "remnawave_panel_id" INTEGER;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "remnawave_panel_username" TEXT;

-- Back to the server default; Prisma opens no transaction per migration, so a
-- plain `SET` would outlive this file on the same connection.
SET lock_timeout = 0;

COMMENT ON COLUMN "subscriptions"."remnawave_panel_id" IS
  'Remnawave numeric user id. Present on 2.x and 3.x alike; on 3.x it is what every user-scoped path segment carries.';
COMMENT ON COLUMN "subscriptions"."remnawave_panel_username" IS
  'Exact panel username the profile was created or linked under. Not recomputable: profile names are built from operator-editable settings.';
