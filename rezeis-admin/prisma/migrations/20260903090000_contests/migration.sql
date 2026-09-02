-- Contests: an event with a draw at the end.
--
-- The wheel is the PERMANENT event; this is the temporary kind. What the two
-- share, on purpose: the prize vocabulary ("WheelSectorKind"), the payout, and
-- the operator's settlement of prizes a human hands over — so a jackpot won in
-- Friday's contest lands in the same kind of row, with the same columns, as
-- one won on the wheel.
--
-- ONE ENTRY PER PERSON. The draw is uniform over people, not over tickets, so
-- nobody can buy their way to better odds. That is the unique index on
-- (contest_id, user_id), and it is the whole of the fairness argument.
--
-- EACH PLACE GOES TO ONE PERSON AND ONE PERSON TAKES ONE PLACE: two unique
-- indexes on contest_winners say so, and a draw that tried to hand somebody
-- two prizes would be refused by the database rather than by a code path.
--
-- NO ENDED STATUS. "Ended, waiting for the draw" is ACTIVE with end_at in the
-- past, and the draw runs within the minute. A status a sweep flips and
-- nothing else reads would be one more thing to keep in step.
--
-- NOTHING IS LIVE. Contests arrive DRAFT; the tables start empty.

SET lock_timeout = '5s';

-- == ENUMS ===================================================================

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ContestStatus') THEN
    CREATE TYPE "ContestStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DRAWN', 'CANCELLED');
  END IF;
END
$do$;

-- A wheel win and a contest win are their own reasons in both journals, not
-- quest rewards wearing a label in `details`. ADD VALUE IF NOT EXISTS is
-- transactional since PostgreSQL 12 and replay-safe on its own.
ALTER TYPE "PointsLedgerSource" ADD VALUE IF NOT EXISTS 'WHEEL_PRIZE';
ALTER TYPE "PointsLedgerSource" ADD VALUE IF NOT EXISTS 'CONTEST_PRIZE';
ALTER TYPE "SpinLedgerSource" ADD VALUE IF NOT EXISTS 'CONTEST_PRIZE';

-- == CONTESTS ================================================================

CREATE TABLE IF NOT EXISTS "contests" (
  "id"              TEXT NOT NULL,
  "title"           JSONB NOT NULL DEFAULT '{}',
  "description"     JSONB NOT NULL DEFAULT '{}',
  "status"          "ContestStatus" NOT NULL DEFAULT 'DRAFT',
  "start_at"        TIMESTAMPTZ(3) NOT NULL,
  "end_at"          TIMESTAMPTZ(3) NOT NULL,
  "audience_filter" JSONB,
  "max_entries"     INTEGER,
  "drawn_at"        TIMESTAMPTZ(3),
  "drawn_entries"   INTEGER,
  "order"           INTEGER NOT NULL DEFAULT 0,
  "created_by"      TEXT,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contests_pkey" PRIMARY KEY ("id")
);

-- The sweep's read: active contests whose end has passed.
CREATE INDEX IF NOT EXISTS "contests_status_end_at_idx"
  ON "contests" ("status", "end_at");
CREATE INDEX IF NOT EXISTS "contests_status_order_idx"
  ON "contests" ("status", "order");

COMMENT ON COLUMN "contests"."drawn_entries" IS
  'How many had entered when the draw ran - the denominator every winner''s odds were. Kept because entries can be pruned later.';
COMMENT ON COLUMN "contests"."audience_filter" IS
  'Who may enter, in the broadcast filter shape. NULL = anybody not blocked.';

-- == PRIZES ==================================================================

CREATE TABLE IF NOT EXISTS "contest_prizes" (
  "id"                  TEXT NOT NULL,
  "contest_id"          TEXT NOT NULL,
  "place"               INTEGER NOT NULL,
  "kind"                "WheelSectorKind" NOT NULL,
  "title"               JSONB NOT NULL DEFAULT '{}',
  "amount"              INTEGER NOT NULL DEFAULT 0,
  "promo_reward_type"   "PromocodeRewardType",
  "promo_plan_id"       TEXT,
  "promo_plan_ids"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "promo_lifetime"      INTEGER,
  "key_pool_id"         TEXT,
  "manual_instructions" TEXT,
  CONSTRAINT "contest_prizes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "contest_prizes_contest_id_place_key"
  ON "contest_prizes" ("contest_id", "place");
CREATE INDEX IF NOT EXISTS "contest_prizes_key_pool_id_idx"
  ON "contest_prizes" ("key_pool_id");

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_prizes_contest_id_fkey') THEN
    ALTER TABLE "contest_prizes"
      ADD CONSTRAINT "contest_prizes_contest_id_fkey"
      FOREIGN KEY ("contest_id") REFERENCES "contests"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_prizes_key_pool_id_fkey') THEN
    ALTER TABLE "contest_prizes"
      ADD CONSTRAINT "contest_prizes_key_pool_id_fkey"
      FOREIGN KEY ("key_pool_id") REFERENCES "wheel_key_pools"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$do$;

-- == ENTRIES =================================================================

CREATE TABLE IF NOT EXISTS "contest_entries" (
  "id"         TEXT NOT NULL,
  "contest_id" TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contest_entries_pkey" PRIMARY KEY ("id")
);

-- One entry per person: the draw is uniform over people, not over tickets.
CREATE UNIQUE INDEX IF NOT EXISTS "contest_entries_contest_id_user_id_key"
  ON "contest_entries" ("contest_id", "user_id");
CREATE INDEX IF NOT EXISTS "contest_entries_user_id_idx"
  ON "contest_entries" ("user_id");

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_entries_contest_id_fkey') THEN
    ALTER TABLE "contest_entries"
      ADD CONSTRAINT "contest_entries_contest_id_fkey"
      FOREIGN KEY ("contest_id") REFERENCES "contests"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_entries_user_id_fkey') THEN
    ALTER TABLE "contest_entries"
      ADD CONSTRAINT "contest_entries_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

-- == WINNERS =================================================================

CREATE TABLE IF NOT EXISTS "contest_winners" (
  "id"               TEXT NOT NULL,
  "contest_id"       TEXT NOT NULL,
  "user_id"          TEXT NOT NULL,
  "prize_id"         TEXT,
  "place"            INTEGER NOT NULL,
  "prize_snapshot"   JSONB NOT NULL,
  "kind"             "WheelSectorKind" NOT NULL,
  "status"           "WheelSpinStatus" NOT NULL,
  "outcome"          JSONB,
  "settled_at"       TIMESTAMPTZ(3),
  "settled_by"       TEXT,
  "settlement_note"  TEXT,
  "manual_ticket_id" TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contest_winners_pkey" PRIMARY KEY ("id")
);

-- Each place to one person; one person one place.
CREATE UNIQUE INDEX IF NOT EXISTS "contest_winners_contest_id_place_key"
  ON "contest_winners" ("contest_id", "place");
CREATE UNIQUE INDEX IF NOT EXISTS "contest_winners_contest_id_user_id_key"
  ON "contest_winners" ("contest_id", "user_id");
CREATE INDEX IF NOT EXISTS "contest_winners_user_id_created_at_idx"
  ON "contest_winners" ("user_id", "created_at" DESC);
-- The operator's queue, same shape as the wheel's.
CREATE INDEX IF NOT EXISTS "contest_winners_status_created_at_idx"
  ON "contest_winners" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "contest_winners_manual_ticket_id_idx"
  ON "contest_winners" ("manual_ticket_id");

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_winners_contest_id_fkey') THEN
    ALTER TABLE "contest_winners"
      ADD CONSTRAINT "contest_winners_contest_id_fkey"
      FOREIGN KEY ("contest_id") REFERENCES "contests"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_winners_user_id_fkey') THEN
    ALTER TABLE "contest_winners"
      ADD CONSTRAINT "contest_winners_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contest_winners_prize_id_fkey') THEN
    ALTER TABLE "contest_winners"
      ADD CONSTRAINT "contest_winners_prize_id_fkey"
      FOREIGN KEY ("prize_id") REFERENCES "contest_prizes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$do$;

COMMENT ON COLUMN "contest_winners"."prize_snapshot" IS
  'What the prize was when it was won. Editing the prize later rewrites nothing.';

-- == A KEY MAY GO OUT IN A DRAW ==============================================

ALTER TABLE "wheel_keys"
  ADD COLUMN IF NOT EXISTS "claimed_winner_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "wheel_keys_claimed_winner_id_key"
  ON "wheel_keys" ("claimed_winner_id");

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wheel_keys_claimed_winner_id_fkey') THEN
    ALTER TABLE "wheel_keys"
      ADD CONSTRAINT "wheel_keys_claimed_winner_id_fkey"
      FOREIGN KEY ("claimed_winner_id") REFERENCES "contest_winners"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$do$;

COMMENT ON COLUMN "wheel_keys"."claimed_winner_id" IS
  'The contest winner this key went to, when it went out in a draw rather than on the wheel.';

RESET lock_timeout;
