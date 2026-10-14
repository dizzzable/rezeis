-- Antilopay SBP subscriptions with a delayed first charge (14.10.2026): two facts
-- a provider subscription keeps beside the ones it already has.
--
--   delay_days         the days of delay the payer was promised when they signed
--                      up («Отсрочка первого списания по СБП»), NULL when the
--                      first charge is made at activation, as before. The payer
--                      holds the plan for these days and is charged after them;
--   delay_granted_at   when the panel gave that access, NULL until it has. It is
--                      the marker of "this customer has used the delay": the
--                      delay is given once per customer, whatever became of the
--                      subscription afterwards, and a row that has it is never
--                      granted again. Written in the same statement block that
--                      rewrites the checkout into the grant, so a look repeated
--                      by a callback retry, the sweep or a crash grants once.
--
-- LIVE DATABASE. Two nullable columns without a default are a catalogue change,
-- not a table rewrite. Timed out, the next start replays this file
-- (`is_auto_recoverable_migration` in `docker-entrypoint.sh`): `IF NOT EXISTS`
-- makes the replay change nothing that already landed.

SET lock_timeout = '5s';

ALTER TABLE "provider_subscriptions" ADD COLUMN IF NOT EXISTS "delay_days" INTEGER;

ALTER TABLE "provider_subscriptions" ADD COLUMN IF NOT EXISTS "delay_granted_at" TIMESTAMPTZ(3);

-- The bound is this file's alone: `migrate deploy` applies every pending
-- migration over one connection.
RESET lock_timeout;
