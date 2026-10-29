-- Contests, finished (29.10.2026). Operators reported the feature as not done;
-- the owner chose what "done" means:
--
--   announce, announced_at      tell the audience a contest has opened. The
--                               flag is the operator's; the stamp says the
--                               sweep has told everybody.
--   results_notified_at         every entrant has heard how they did.
--   tickets_per_purchase,       extra chances for a paid purchase, and for a
--   tickets_per_referral,       friend who paid, inside the contest window;
--   max_tickets_per_user        a ceiling per person. 0 / 0 / NULL is the old
--                               "one person, one chance".
--   channel_chat_id,            entering needs a subscription to this channel.
--   channel_join_url
--   draw_seed, draw_seed_hash   the draw's source of chance, made at publish.
--                               The hash is shown while the contest runs and
--                               the seed after the draw, so nobody can change
--                               it on the way. NULL on contests published
--                               before this: they keep drawing from their id.
--   drawn_tickets               how many tickets were in the draw.
--   draw_error, draw_error_at   why the last draw attempt failed — it was only
--                               in the log, and the panel said "awaiting draw"
--                               for ever.
--
--   contest_entries.tickets     a person's tickets as the draw counted them.
--   contest_notices             one row per person per notice, so a retried
--                               sweep never sends the same message twice.
--
-- Contests drawn before this file already had their results: they are marked
-- as told, or the first sweep would message every past entrant.
--
-- LIVE DATABASE. Nullable columns and constant defaults are catalogue changes,
-- not table rewrites. Timed out, the next start replays this file
-- (`is_auto_recoverable_migration` in `docker-entrypoint.sh`): every statement
-- is guarded, and the backfill only touches rows still unmarked.

SET lock_timeout = '5s';

ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "announce" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "announced_at" TIMESTAMPTZ(3);
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "results_notified_at" TIMESTAMPTZ(3);
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "tickets_per_purchase" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "tickets_per_referral" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "max_tickets_per_user" INTEGER;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "channel_chat_id" TEXT;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "channel_join_url" TEXT;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "draw_seed" TEXT;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "draw_seed_hash" TEXT;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "drawn_tickets" INTEGER;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "draw_error" TEXT;
ALTER TABLE "contests" ADD COLUMN IF NOT EXISTS "draw_error_at" TIMESTAMPTZ(3);

ALTER TABLE "contest_entries" ADD COLUMN IF NOT EXISTS "tickets" INTEGER;

UPDATE "contests"
   SET "results_notified_at" = COALESCE("drawn_at", "updated_at")
 WHERE "status" = 'DRAWN'
   AND "results_notified_at" IS NULL;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ContestNoticeKind') THEN
    CREATE TYPE "ContestNoticeKind" AS ENUM ('ANNOUNCED', 'RESULT');
  END IF;
END
$do$;

CREATE TABLE IF NOT EXISTS "contest_notices" (
  "id"         TEXT NOT NULL,
  "contest_id" TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "kind"       "ContestNoticeKind" NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contest_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "contest_notices_contest_id_kind_user_id_key"
  ON "contest_notices" ("contest_id", "kind", "user_id");
CREATE INDEX IF NOT EXISTS "contest_notices_user_id_idx"
  ON "contest_notices" ("user_id");

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_notices_contest_id_fkey') THEN
    ALTER TABLE "contest_notices"
      ADD CONSTRAINT "contest_notices_contest_id_fkey"
      FOREIGN KEY ("contest_id") REFERENCES "contests"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_notices_user_id_fkey') THEN
    ALTER TABLE "contest_notices"
      ADD CONSTRAINT "contest_notices_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

-- The bound is this file's alone: `migrate deploy` applies every pending
-- migration over one connection.
RESET lock_timeout;
