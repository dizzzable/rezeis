-- Add-on lifetime default: UNTIL_NEXT_RESET -> UNTIL_SUBSCRIPTION_END.
--
-- Why: a reset-scoped lifetime (UNTIL_NEXT_RESET) is gated behind the
-- per-strategy reset-expiry rollout flags (ADDON_RESET_EXPIRY_*, OFF by
-- default until staging parity), so add-ons created with it are withheld from
-- the cabinet eligibility and their "Докупить"/top-up button stays disabled.
-- The admin form never exposed a lifetime picker, so EVERY operator-created
-- add-on inherited the old default and was therefore invisible.
--
-- Fix: the usable default is UNTIL_SUBSCRIPTION_END (always eligible for a
-- dated subscription). Flip the column default AND backfill existing rows that
-- still carry the old default so they become visible immediately. These rows
-- were never sellable (invisible), so no entitlement snapshot depends on the
-- old value and no revision bump is needed.
ALTER TABLE "add_ons" ALTER COLUMN "lifetime" SET DEFAULT 'UNTIL_SUBSCRIPTION_END';

UPDATE "add_ons"
SET "lifetime" = 'UNTIL_SUBSCRIPTION_END'
WHERE "lifetime" = 'UNTIL_NEXT_RESET';
