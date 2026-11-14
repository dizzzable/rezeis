-- Which plan of a merged link the VPN app shows (14.11.2026).
--
-- A merged link carries several profiles, but the client reads exactly one
-- `profile-title` and one `subscription-userinfo` header. Until now those were
-- "the first source that answered", which made the unlimited half of a
-- «Безлимит + Лимитный» bundle win the traffic line and hide the limit the
-- customer actually needs to see. The operator now names the plan that faces
-- the app; this column stores that choice, one flagged member per bundle.
--
-- A flag rather than a `PlanBundle.visible_plan_id` column: the member row is
-- what gets recreated when the plans of a bundle change, so a chosen plan that
-- left the bundle cannot dangle in a foreign key nothing else checks.
--
-- Additive and replay-safe: a start that timed out re-applies this file, and
-- `ADD COLUMN IF NOT EXISTS` makes the second run a no-op. No index is added —
-- a bundle has a handful of members and they are always read through
-- `bundle_id`, which is already indexed.

ALTER TABLE "plan_bundle_members"
  ADD COLUMN IF NOT EXISTS "is_visible_in_app" BOOLEAN NOT NULL DEFAULT false;
