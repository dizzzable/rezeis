-- A caption per plan for the extra traffic lines of a merged subscription
-- (14.11.2026).
--
-- The bot draws one «Трафик» line for the bundle's main plan and a «Трафик доп.»
-- line for every further limited plan. Those captions used to come from the bot
-- texts alone (`profile.traffic_extra`, then the «+» windows
-- `profile.traffic_extra_2`, …), which cannot say WHICH plan a line belongs to:
-- the third and fourth lines were numbered by position, so reordering plans
-- (or dropping one) moved every caption after it.
--
-- The caption now belongs to the member plan it describes: the operator types it
-- once in the bundle card and the bot prefers it over the window text. NULL —
-- every row that existed before this release — means "use the default
-- `profile.traffic_extra` caption", so nothing changes until a bundle is saved
-- with labels.
--
-- Additive and replay-safe: a start that timed out re-applies this file, and
-- `ADD COLUMN IF NOT EXISTS` makes the second run a no-op. No index: the column
-- is read with the member rows, which are always read through `bundle_id`.

ALTER TABLE "plan_bundle_members"
  ADD COLUMN IF NOT EXISTS "traffic_label" TEXT;
