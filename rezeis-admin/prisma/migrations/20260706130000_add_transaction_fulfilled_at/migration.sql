-- Provisioning idempotency stamp for payment transactions.
-- Set atomically inside the fulfillment transaction once a subscription has
-- been created/renewed/upgraded for the payment. The webhook reconciler
-- fulfils only when this is NULL, so single-subscription RENEW/UPGRADE (whose
-- subscription_id points at the source subscription from draft time) is
-- provisioned exactly once instead of being wrongly skipped.
ALTER TABLE "transactions" ADD COLUMN "fulfilled_at" TIMESTAMPTZ(3);

-- Backfill: existing COMPLETED transactions are already provisioned (or were
-- handled manually) -- stamp them so a replayed webhook never re-provisions.
-- (COMPLETED rows are historical/immutable, so a single UPDATE is safe.)
UPDATE "transactions" SET "fulfilled_at" = "updated_at" WHERE "status" = 'COMPLETED';
