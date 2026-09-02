-- The wheel's spin wallet: a balance, its journal, and the free spin's clock.
--
-- WHY TWO DIFFERENT THINGS AND NOT ONE COUNTER. A spin can be won or bought,
-- and those accumulate: three on the balance plus five won is eight. The FREE
-- spin does not accumulate — the operator grants one per cooldown, and a
-- person who does not spin for a week still has exactly one when they come
-- back. Expressed as a counter that would need a nightly sweep across every
-- account to decide who gets topped up, and an answer that drifts the moment
-- the sweep is late. Expressed as "when did you last spend the free one" it is
-- a subtraction at read time, correct for everybody, and costs nothing.
--
-- WHY A SECOND LEDGER RATHER THAN A COLUMN ON THE POINTS ONE. The two wallets
-- answer different questions, carry different sources and are read by
-- different screens; a shared table would put a "which wallet" filter into
-- every query, and the first query that forgets it reports somebody's spins as
-- points. What is shared here is the DISCIPLINE — one writer, the floor inside
-- the conditional write, the journal row in the same transaction — and that is
-- guarded per wallet by its own test against a live database.
--
-- NO BACKFILL. The balance arrives at zero for everyone, so the journal starts
-- empty and is complete from its first row. There is deliberately no
-- OPENING_BALANCE source: nothing would ever write it.

SET lock_timeout = '5s';

-- == ENUM ====================================================================

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SpinLedgerSource') THEN
    CREATE TYPE "SpinLedgerSource" AS ENUM (
      'WHEEL_PRIZE',
      'PURCHASED',
      'SPENT',
      'MANUAL_ADJUSTMENT'
    );
  END IF;
END
$do$;

-- == BALANCE AND THE FREE SPIN'S CLOCK =======================================
--
-- Constant default and a nullable column: PostgreSQL adds both without
-- rewriting `users`, which is the widest, hottest table in this schema.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "spin_balance" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "free_spin_used_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "users"."spin_balance" IS
  'Wheel spins won or bought. These accumulate. The free spin is not counted here.';
COMMENT ON COLUMN "users"."free_spin_used_at" IS
  'When the free spin was last consumed. Available again once older than the configured cooldown, which is why it never piles up: not spinning does not start the clock.';

-- == JOURNAL =================================================================

CREATE TABLE IF NOT EXISTS "spin_ledger" (
  "id"            TEXT NOT NULL,
  "user_id"       TEXT NOT NULL,
  "delta"         INTEGER NOT NULL,
  "balance_after" INTEGER NOT NULL,
  "source"        "SpinLedgerSource" NOT NULL,
  "reference_key" TEXT,
  "details"       JSONB,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "spin_ledger_pkey" PRIMARY KEY ("id")
);

-- Idempotency lives in the index, not in application memory: a spin request
-- replayed after a dropped connection carries the same key and the second
-- insert is refused, so a lost response never costs a second spin. NULL keys
-- (an operator's adjustment) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS "spin_ledger_source_reference_key_key"
  ON "spin_ledger" ("source", "reference_key");

-- The only read: one person's history, newest first.
CREATE INDEX IF NOT EXISTS "spin_ledger_user_id_created_at_idx"
  ON "spin_ledger" ("user_id", "created_at" DESC);

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spin_ledger_user_id_fkey'
  ) THEN
    ALTER TABLE "spin_ledger"
      ADD CONSTRAINT "spin_ledger_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

COMMENT ON TABLE "spin_ledger" IS
  'One row per movement of users.spin_balance, written by SpinWalletService together with the balance update. For every user SUM(delta) = users.spin_balance.';
COMMENT ON COLUMN "spin_ledger"."balance_after" IS
  'The balance the database held when this row was written - read back under the row lock the update took, never computed from an earlier read.';
COMMENT ON COLUMN "spin_ledger"."reference_key" IS
  'Idempotency handle, unique per source: the spin id for SPENT and for the WHEEL_PRIZE it produced, the purchase id for PURCHASED. NULL for an operator adjustment.';

RESET lock_timeout;
