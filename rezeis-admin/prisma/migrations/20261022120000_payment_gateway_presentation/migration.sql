-- How a payment gateway looks to the customer (22.10.2026): the operator's own
-- name, a line under it and an icon in the cabinet's payment step, in place of
-- the provider's name, the currency code and the provider's logo. Customers
-- did not know what «Platega» or «Wata» take and were afraid to press them.
--
--   display_name         «Карта или СБП». NULL — the provider's name.
--   display_description  up to three lines under the name. NULL — the currency
--                        code, as before.
--   display_icon_svg     the operator's SVG, checked on save
--                        (`gateway-presentation.util.ts`) and shown in the
--                        cabinet only as an image. NULL — the provider's logo.
--
-- LIVE DATABASE. Three nullable columns without a default are a catalogue
-- change, not a table rewrite. Timed out, the next start replays this file
-- (`is_auto_recoverable_migration` in `docker-entrypoint.sh`): `IF NOT EXISTS`
-- makes the replay change nothing that already landed.

SET lock_timeout = '5s';

ALTER TABLE "payment_gateways" ADD COLUMN IF NOT EXISTS "display_name" TEXT;

ALTER TABLE "payment_gateways" ADD COLUMN IF NOT EXISTS "display_description" TEXT;

ALTER TABLE "payment_gateways" ADD COLUMN IF NOT EXISTS "display_icon_svg" TEXT;

-- The bound is this file's alone: `migrate deploy` applies every pending
-- migration over one connection.
RESET lock_timeout;
