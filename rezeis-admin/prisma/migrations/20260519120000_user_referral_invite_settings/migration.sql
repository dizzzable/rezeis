-- Per-user override for referral invite limits.
--
-- NULL  → use the global `Settings.referralSettings.invite_limits` block.
-- JSON  → object whose keys mirror the global keys; non-null members
--         override the corresponding global value one-by-one.
--
-- Donor parity: altshop `users.referral_invite_settings` (JSON) +
--               `ReferralInviteIndividualSettingsDto`.
ALTER TABLE "users"
  ADD COLUMN "referral_invite_settings" JSONB;
