-- The OS a customer first opened the installed app on, kept on the user row.
--
-- `pwa_installed_at` has always been stamped by the first cabinet report whose
-- surface is the installed app, but the OS of that report was not kept anywhere
-- durable: `last_os` belongs to whatever the customer opened LAST, and the only
-- record of the first open's OS was the `user.pwa_installed` audit row
-- (since v0.9.7.39), which the six-hourly rotation deletes after
-- `AUDIT_RETENTION_DAYS` (90 by default). From now on the conditional update
-- that stamps `pwa_installed_at` writes this column in the same statement.
--
-- Nullable, no default: a catalogue change on "users", no table rewrite.
-- `IF NOT EXISTS` so a partially applied run replays.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pwa_installed_os" TEXT;

-- Carry over what the audit log still holds, for customers who installed
-- before this column existed.
--
--   * the milestone's own rows only (`event.user.pwa_installed`), whose
--     `userId` is a JSON STRING — `users.id` is TEXT, and `->>` renders a JSON
--     number as text too, so a number that happens to spell an id must not
--     match — and whose `os` is one of the six values the cabinet's clamp
--     (`normalizeOs`) can write;
--   * of those, the EARLIEST per customer: one row is written per account, and
--     a later one is never the first open;
--   * only customers who are installed and have no value yet, so a replay, or
--     a value the writer already put there, is left alone.
UPDATE "users" AS u
   SET "pwa_installed_os" = first_open."os"
  FROM (
        SELECT DISTINCT ON ("metadata"->>'userId')
               "metadata"->>'userId' AS "user_id",
               "metadata"->>'os'     AS "os"
          FROM "admin_audit_log"
         WHERE "action" = 'event.user.pwa_installed'
           AND jsonb_typeof("metadata"->'userId') = 'string'
           AND "metadata"->>'os' IN ('ios', 'android', 'windows', 'macos', 'linux', 'other')
         ORDER BY "metadata"->>'userId', "created_at" ASC, "id" ASC
       ) AS first_open
 WHERE u."id" = first_open."user_id"
   AND u."pwa_installed_at" IS NOT NULL
   AND u."pwa_installed_os" IS NULL;
