-- Claim-pending flag for migrated web-only accounts (e.g. altshop import).
-- While true, the first cabinet sign-in adopts the submitted password, clears
-- the flag, and forces a password change. Only an importer sets it.
ALTER TABLE "web_accounts"
  ADD COLUMN "password_bootstrap_pending" boolean NOT NULL DEFAULT false;
