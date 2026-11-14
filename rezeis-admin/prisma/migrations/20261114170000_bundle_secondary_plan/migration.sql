-- Which plan's traffic the CABINET CARD prints under its own traffic row
-- (14.11.2026).
--
-- The owner asked for the swipeable traffic pager to go away and for a single
-- fixed second line instead: «0.01/50 ГБ» — used of the plan's cap. Which plan
-- that is (or none at all) is the OPERATOR's choice, made in the bundle card
-- next to the device limit, not in the plan editor: it is a property of the
-- merged product.
--
-- NULL means "no second line". A foreign key with ON DELETE SET NULL keeps a
-- plan deletion from breaking the bundle: the card simply loses its second line
-- instead of failing to load.
--
-- Additive and replay-safe: a start that timed out re-applies this file, and
-- `ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` make the second run a
-- no-op. No index: the column is read with the bundle row, by primary key.

ALTER TABLE "plan_bundles"
  ADD COLUMN IF NOT EXISTS "secondary_plan_id" TEXT;

ALTER TABLE "plan_bundles"
  DROP CONSTRAINT IF EXISTS "plan_bundles_secondary_plan_id_fkey";

ALTER TABLE "plan_bundles"
  ADD CONSTRAINT "plan_bundles_secondary_plan_id_fkey"
  FOREIGN KEY ("secondary_plan_id") REFERENCES "plans"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
