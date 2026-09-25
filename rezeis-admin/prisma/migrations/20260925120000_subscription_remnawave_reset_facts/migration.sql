-- Two facts about a subscription's Remnawave profile that «Докупка трафика до
-- сброса» (stage 4, 25.09.2026) needs, kept on the subscription itself:
--
--   remnawave_profile_created_at     the profile's own `createdAt`, which is
--                                    the anchor Remnawave resets a
--                                    MONTH_ROLLING profile from (the UTC day of
--                                    month of it; never in the first month);
--   remnawave_last_traffic_reset_at  when Remnawave last zeroed the profile's
--                                    counter (`lastTrafficResetAt`) — what the
--                                    boundary sweep reads to confirm a reset
--                                    before it takes a «до сброса» add-on off.
--
-- Both are stamped from every full Remnawave user the panel sees, whatever the
-- subscription's status (`remnawave-profile-facts.util.ts`). Nullable: `NULL`
-- is "never seen", which every reader treats as unknown.
--
-- BACKFILL. The first column is seeded from what the panel already recorded:
-- the newest MONTH_ROLLING term's `reset_anchor_at`, which profile sync and the
-- term activation stamp from the profile's `createdAt`. ONLY rolling terms: a
-- DAY / WEEK / MONTH term's `reset_anchor_at` is the TERM's start
-- (`provisionalResetAnchor`), not the profile's creation, and copying it here
-- would hand a later rolling plan a reset day that is not Remnawave's. Rows
-- with nothing recorded stay NULL until the next answer from Remnawave. The
-- second column has no earlier record anywhere and starts NULL.
--
-- LIVE DATABASE. Two nullable columns without a default are a catalogue change,
-- not a table rewrite. The backfill touches each subscription with a rolling
-- term once, and only where the column is still NULL. `lock_timeout` bounds
-- the wait behind a long reader or a row a writer holds. Timed out, the next
-- start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`): `IF NOT EXISTS` and the `IS NULL` guard make the
-- replay change nothing that already landed.

SET lock_timeout = '5s';

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "remnawave_profile_created_at" TIMESTAMPTZ(3);

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "remnawave_last_traffic_reset_at" TIMESTAMPTZ(3);

UPDATE "subscriptions" AS s
   SET "remnawave_profile_created_at" = anchor."reset_anchor_at"
  FROM (
    SELECT DISTINCT ON (t."subscription_id") t."subscription_id", t."reset_anchor_at"
      FROM "subscription_terms" AS t
     WHERE t."reset_anchor_at" IS NOT NULL
       AND t."traffic_reset_strategy" = 'MONTH_ROLLING'
     ORDER BY t."subscription_id", t."generation" DESC
  ) AS anchor
 WHERE s."id" = anchor."subscription_id"
   AND s."remnawave_profile_created_at" IS NULL;

-- The bound is this file's alone: `migrate deploy` applies every pending
-- migration over one connection.
RESET lock_timeout;
