-- Per-method autopay flag: keep card bound but stop off-session charges when false.
-- Additive only; existing rows default to true (eligible for charge).
ALTER TABLE "saved_payment_methods"
  ADD COLUMN "autopay_enabled" BOOLEAN NOT NULL DEFAULT true;
