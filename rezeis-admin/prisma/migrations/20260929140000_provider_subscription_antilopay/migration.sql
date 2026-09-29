-- Antilopay autopay (29.09.2026): four facts a provider subscription of that
-- gateway keeps beside the ones Platega and RollyPay already use.
--
--   provider_recurrent_id  Antilopay's `recurrent_id`. `payment/create` answers
--                          with the initiating payment's id only, so the row is
--                          keyed by that (`provider_subscription_id`, which
--                          Antilopay also accepts as `transaction_id` to cancel)
--                          and the recurrent's own id, which every later callback
--                          names, is written here once it is known;
--   ends_at                the end of the provider's plan of charges
--                          (`end_date` of `payment/recurrent/check`);
--   planned_charge_count   how many charges it plans in all, the first included
--                          (`count`);
--   method                 CARD or SBP, the two ways Antilopay repeats a charge.
--
-- LIVE DATABASE. Four nullable columns without a default are a catalogue change,
-- not a table rewrite; the unique index is over a table of a few thousand rows
-- at most, whose new column is NULL everywhere (NULLs never collide). Timed out,
-- the next start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`): `IF NOT EXISTS` makes the replay change nothing that
-- already landed.

SET lock_timeout = '5s';

ALTER TABLE "provider_subscriptions" ADD COLUMN IF NOT EXISTS "provider_recurrent_id" TEXT;

ALTER TABLE "provider_subscriptions" ADD COLUMN IF NOT EXISTS "ends_at" TIMESTAMPTZ(3);

ALTER TABLE "provider_subscriptions" ADD COLUMN IF NOT EXISTS "planned_charge_count" INTEGER;

ALTER TABLE "provider_subscriptions" ADD COLUMN IF NOT EXISTS "method" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "provider_subscriptions_gateway_type_provider_recurrent_id_key"
  ON "provider_subscriptions"("gateway_type", "provider_recurrent_id");

-- The bound is this file's alone: `migrate deploy` applies every pending
-- migration over one connection.
RESET lock_timeout;
