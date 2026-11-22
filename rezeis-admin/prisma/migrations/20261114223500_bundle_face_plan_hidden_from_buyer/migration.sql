-- A bundle that is ALSO a tariff, and plans an operator hides from the buyer
-- (14.11.2026).
--
-- 1. `plans.hidden_from_buyer` is the operator's «Скрыть от покупателя»
--    switch. It is deliberately a separate column: `is_active` also stops
--    grants and renewals, `is_archived` is about transitions, and neither can
--    hide a plan from the catalog while keeping it issuable.
--
-- 2. `plan_bundles.plan_id` links a grouping to the ONE plan row that is issued
--    as «объединённая подписка». The row is a normal plan (name, description,
--    prices, durations, device limit) whose traffic limit, type and Remnawave
--    squads mirror the bundle's visible member plan. NULL for every grouping
--    created before this release and for one whose plan was removed.
--
-- Additive and replay-safe: a start that timed out re-applies this file, and
-- every statement tolerates a second run (`IF NOT EXISTS`). The foreign key is
-- guarded by a constraint-name check because Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`.

ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "hidden_from_buyer" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "plan_bundles"
  ADD COLUMN IF NOT EXISTS "plan_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "plan_bundles_plan_id_key"
  ON "plan_bundles"("plan_id");

CREATE INDEX IF NOT EXISTS "plans_hidden_from_buyer_idx"
  ON "plans"("hidden_from_buyer");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_bundles_plan_id_fkey'
  ) THEN
    ALTER TABLE "plan_bundles"
      ADD CONSTRAINT "plan_bundles_plan_id_fkey"
      FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
