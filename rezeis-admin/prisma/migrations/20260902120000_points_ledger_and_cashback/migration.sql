-- The points wallet gets a journal, and plans, add-ons and settings get the
-- columns a purchase cashback reads.
--
-- WHAT WAS WRONG. `users.points` is one integer with EIGHT writers in the code
-- base — referral payouts and their refund reversal, quest rewards, the
-- exchange, the operator's manual adjustment, two importers and the account
-- merge — and no table that records a movement. "Where did my points come
-- from" is answered by reading four tables and the audit log side by side, and
-- one of the writers (the referral reversal) debits with no floor, so the
-- column can already go negative today.
--
-- WHAT THIS ADDS. `points_ledger`: one row per movement with the balance the
-- row left behind. From this migration on every writer goes through
-- `PointsWalletService`, which writes the conditional balance update and the
-- row in the same transaction. The invariant a test on a live database
-- guards: for every user, SUM(delta) over the ledger equals `users.points`.
--
-- WHAT DOES NOT CHANGE. `users.points` stays the balance the panel, the
-- cabinet and the bot read; nothing starts reading the ledger instead. The
-- cashback columns default to INHERIT with the global rule OFF, so a plan or
-- an add-on behaves exactly as before until an operator turns cashback on.
--
-- OPENING BALANCE. Every user holding a non-zero balance gets ONE
-- OPENING_BALANCE row for the whole amount, so the ledger reconciles with the
-- column from the first day rather than from the first movement. Guarded by
-- "no ledger row for this user yet": once the application has written a
-- movement, a replay of this file must NOT add an opening row on top of it —
-- that would put the sum above the balance by exactly the movements made
-- since. Negative balances (the unfloored reversal) are carried as they are:
-- the sum has to match the column, not flatter it.

SET lock_timeout = '5s';

-- == ENUMS ==================================================================

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PointsLedgerSource') THEN
    CREATE TYPE "PointsLedgerSource" AS ENUM (
      'CASHBACK',
      'CASHBACK_REVERSED',
      'REFERRAL_REWARD',
      'REFERRAL_REWARD_REVOKED',
      'QUEST_REWARD',
      'EXCHANGE',
      'MANUAL_ADJUSTMENT',
      'ACCOUNT_MERGE',
      'IMPORT',
      'OPENING_BALANCE'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PointsCashbackMode') THEN
    CREATE TYPE "PointsCashbackMode" AS ENUM ('INHERIT', 'NONE', 'PERCENT', 'FIXED');
  END IF;
END
$do$;

-- == LEDGER =================================================================

CREATE TABLE IF NOT EXISTS "points_ledger" (
  "id"            TEXT NOT NULL,
  "user_id"       TEXT NOT NULL,
  "delta"         INTEGER NOT NULL,
  "balance_after" INTEGER NOT NULL,
  "source"        "PointsLedgerSource" NOT NULL,
  "reference_key" TEXT,
  "details"       JSONB,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "points_ledger_pkey" PRIMARY KEY ("id")
);

-- Idempotency lives in the index, not in application memory: a cashback hook
-- that runs twice for one transaction, a refund reversal replayed by a second
-- webhook, a referral payout re-driven by the sweep — each carries the same
-- (source, reference_key) and the second insert is refused. NULL keys (manual
-- adjustments) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS "points_ledger_source_reference_key_key"
  ON "points_ledger" ("source", "reference_key");

-- The only read: a user's history, newest first.
CREATE INDEX IF NOT EXISTS "points_ledger_user_id_created_at_idx"
  ON "points_ledger" ("user_id", "created_at" DESC);

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'points_ledger_user_id_fkey'
  ) THEN
    ALTER TABLE "points_ledger"
      ADD CONSTRAINT "points_ledger_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

COMMENT ON TABLE "points_ledger" IS
  'One row per movement of users.points, written by PointsWalletService together with the balance update. For every user SUM(delta) = users.points.';
COMMENT ON COLUMN "points_ledger"."balance_after" IS
  'The balance the database held when this row was written - read back under the row lock the update took, never computed from an earlier read.';
COMMENT ON COLUMN "points_ledger"."reference_key" IS
  'Idempotency handle, unique per source: transaction id for CASHBACK and CASHBACK_REVERSED, reward id for REFERRAL_*, exchange id for EXCHANGE, completion id for QUEST_REWARD. NULL for movements that are not idempotent by nature.';
COMMENT ON COLUMN "points_ledger"."details" IS
  'What the row is shown as: plan/term/price for a cashback, type and value for an exchange, reason and operator for an adjustment, requested/applied/shortfall for a floored reversal.';

-- == CASHBACK RULE COLUMNS ==================================================
--
-- Constant defaults, so PostgreSQL adds them without rewriting the tables.

ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "cashback_mode" "PointsCashbackMode" NOT NULL DEFAULT 'INHERIT';
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "cashback_percent" INTEGER;
ALTER TABLE "plan_durations"
  ADD COLUMN IF NOT EXISTS "cashback_points" INTEGER;

ALTER TABLE "add_ons"
  ADD COLUMN IF NOT EXISTS "cashback_mode" "PointsCashbackMode" NOT NULL DEFAULT 'INHERIT';
ALTER TABLE "add_ons"
  ADD COLUMN IF NOT EXISTS "cashback_percent" INTEGER;
ALTER TABLE "add_ons"
  ADD COLUMN IF NOT EXISTS "cashback_points" INTEGER;

ALTER TABLE "settings"
  ADD COLUMN IF NOT EXISTS "points_settings" JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN "plans"."cashback_mode" IS
  'INHERIT follows settings.points_settings.cashback; NONE excludes the plan; PERCENT reads cashback_percent; FIXED reads plan_durations.cashback_points of the purchased duration.';
COMMENT ON COLUMN "add_ons"."cashback_mode" IS
  'Same modes as plans.cashback_mode; an add-on has no durations, so FIXED reads add_ons.cashback_points.';
COMMENT ON COLUMN "settings"."points_settings" IS
  'Points programme: { cashback: { enabled, percent } }. Empty means OFF.';

-- == BACKFILL: opening balance ==============================================

INSERT INTO "points_ledger" ("id", "user_id", "delta", "balance_after", "source", "reference_key", "created_at")
SELECT
  md5('points-opening:' || u."id"),
  u."id",
  u."points",
  u."points",
  'OPENING_BALANCE',
  u."id",
  CURRENT_TIMESTAMP
FROM "users" u
WHERE u."points" <> 0
  AND NOT EXISTS (
    SELECT 1 FROM "points_ledger" l WHERE l."user_id" = u."id"
  )
ON CONFLICT DO NOTHING;

RESET lock_timeout;
