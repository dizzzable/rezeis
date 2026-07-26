-- Freeze the attribution window at first touch. It used to be read from the
-- placement at payment time, so editing the window rewrote which past purchases
-- counted as advertising revenue.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "acquisition_window_days" INTEGER;

-- Backfill from the placement each user was acquired by, so existing
-- attributions keep the window they were actually judged against today.
UPDATE "users" u
   SET "acquisition_window_days" = p."attribution_window_days"
  FROM "ad_placements" p
 WHERE u."acquisition_placement_id" = p."id"
   AND u."acquisition_window_days" IS NULL;
