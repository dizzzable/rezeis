-- Device add-ons and traffic resets last until the end of the subscription
-- (the owner's decision of 24.09.2026, stage 4).
--
-- «До следующего сброса» belongs to TRAFFIC. The catalogue used to accept it
-- on any type, and a device slot set that way would have ended at the next
-- traffic reset — and, with automatic device cleanup, taken the customer's
-- newest device with it. The panel now refuses it on anything but traffic
-- (`AdminAddOnCreateDto` / `AddOnsService`) and sells devices «до конца
-- подписки» whatever the row says (`resolveEffectiveAddOnLifetime`); this
-- brings the rows already stored in line, so the editor, the API and the sale
-- agree about them. A traffic reset has no lifetime at all; its rows are
-- normalised the same way, so an edit of one is not refused for a value the
-- editor no longer shows.
--
-- WHICH ROWS. `add_ons` of type EXTRA_DEVICES or RESET_TRAFFIC that still say
-- UNTIL_NEXT_RESET — archived ones included, so none can come back with it.
-- Entitlements already sold keep their dates: their lifetime and `expires_at`
-- are on `add_on_entitlements`, which this does not touch.
--
-- `revision` moves as it does for every commercial change made in the panel
-- (`AddOnsService.update`), so a checkout pinned to the old composition is
-- told the add-on changed instead of being sold the new one silently.
--
-- REPLAY. One statement; it only touches rows that still say
-- UNTIL_NEXT_RESET, so running it again changes nothing. `lock_timeout` bounds
-- the wait behind an editor saving one of these rows. Timed out, the next
-- start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`).

SET lock_timeout = '5s';

UPDATE "add_ons"
   SET "lifetime" = 'UNTIL_SUBSCRIPTION_END',
       "revision" = "revision" + 1,
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "lifetime" = 'UNTIL_NEXT_RESET'
   AND "type" IN ('EXTRA_DEVICES', 'RESET_TRAFFIC');

-- The bound is this file's alone: `migrate deploy` applies every pending
-- migration over one connection.
RESET lock_timeout;
