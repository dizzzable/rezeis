-- Traffic-reset add-on: a purchasable ACTION rather than a grant.
--
-- WHY A NEW ENUM VALUE AND A NEW TABLE, AND NOT A THIRD "VALUE" COLUMN.
-- `EXTRA_TRAFFIC` and `EXTRA_DEVICES` are grants: they hold a value, expire on
-- a date and can be revoked. A reset holds nothing — by the time the row
-- exists the counter is already back at zero. Modelling it as an entitlement
-- would create a lifecycle record whose every lifecycle field is meaningless.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH. Reset epochs and entitlement
-- `expires_at` are left alone. Epochs track the PLAN's reset cycle, and moving
-- them would shorten extra gigabytes somebody already paid for. A purchased
-- reset zeroes CONSUMED traffic; the limit, and every add-on inside it, lives
-- out the term it was sold for.
--
-- Replay-safe throughout: every statement is guarded, so a run interrupted by
-- the lock timeout below can simply be repeated.
SET lock_timeout = '5s';

-- The enum value is added in its own statement because PostgreSQL refuses to
-- use a label added inside the same transaction that created it. Nothing here
-- uses it; the columns below only need the TYPE to exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'RESET_TRAFFIC'
      AND enumtypid = 'public."AddOnType"'::regtype
  ) THEN
    ALTER TYPE "AddOnType" ADD VALUE 'RESET_TRAFFIC';
  END IF;
END
$$;

-- NOT NULL with a default and no backfill: every existing add-on is a grant,
-- and a grant has no free allowance. `0` is "always paid", which is what they
-- have always been.
ALTER TABLE "add_ons"
  ADD COLUMN IF NOT EXISTS "free_uses_per_term" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "subscription_traffic_resets" (
  "id"              TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "term_id"         TEXT,
  "add_on_id"       TEXT,
  "transaction_id"  TEXT,
  "performed_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_traffic_resets_pkey" PRIMARY KEY ("id")
);

-- Both reads this table serves: the customer-visible history for one
-- subscription, and the free-allowance count for one term.
CREATE INDEX IF NOT EXISTS "subscription_traffic_resets_subscription_id_performed_at_idx"
  ON "subscription_traffic_resets" ("subscription_id", "performed_at");
CREATE INDEX IF NOT EXISTS "subscription_traffic_resets_subscription_id_term_id_idx"
  ON "subscription_traffic_resets" ("subscription_id", "term_id");

-- CASCADE, unlike most foreign keys here: this row is a fact about ONE
-- subscription and means nothing without it. The money it may point at lives
-- in `transactions`, which this does not touch.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscription_traffic_resets_subscription_id_fkey'
  ) THEN
    ALTER TABLE "subscription_traffic_resets"
      ADD CONSTRAINT "subscription_traffic_resets_subscription_id_fkey"
      FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

COMMENT ON TABLE "subscription_traffic_resets" IS
  'One performed traffic reset, paid or free. Both the customer-visible history and the counter free_uses_per_term is measured against; a null transaction_id means it came from the free allowance.';
COMMENT ON COLUMN "add_ons"."free_uses_per_term" IS
  'How many times this add-on may be taken free per subscription term before it starts costing money. 0 = always paid.';

RESET lock_timeout;
