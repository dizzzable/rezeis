-- Durable, non-payment history for referral point exchanges. This migration is
-- additive: existing payment transactions and promocode activations remain
-- untouched and can be merged by the admin operations feed.

CREATE TYPE "ReferralPointsExchangeType" AS ENUM (
  'SUBSCRIPTION_DAYS',
  'GIFT_SUBSCRIPTION',
  'DISCOUNT',
  'TRAFFIC'
);

CREATE TABLE "referral_points_exchanges" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "target_subscription_id" TEXT,
  "type" "ReferralPointsExchangeType" NOT NULL,
  "points_spent" INTEGER NOT NULL,
  "reward_value" INTEGER NOT NULL,
  "expires_at_before" TIMESTAMPTZ(3),
  "expires_at_after" TIMESTAMPTZ(3),
  "traffic_limit_before" INTEGER,
  "traffic_limit_after" INTEGER,
  "personal_discount_before" INTEGER,
  "personal_discount_after" INTEGER,
  "gift_promocode_id" TEXT,
  "profile_sync_job_id" TEXT,
  "idempotency_key" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "referral_points_exchanges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referral_points_exchanges_gift_promocode_id_key"
  ON "referral_points_exchanges"("gift_promocode_id");
CREATE UNIQUE INDEX "referral_points_exchanges_profile_sync_job_id_key"
  ON "referral_points_exchanges"("profile_sync_job_id");
CREATE UNIQUE INDEX "referral_points_exchanges_user_id_idempotency_key_key"
  ON "referral_points_exchanges"("user_id", "idempotency_key");
CREATE INDEX "referral_points_exchanges_user_id_created_at_idx"
  ON "referral_points_exchanges"("user_id", "created_at");
CREATE INDEX "referral_points_exchanges_target_subscription_id_created_at_idx"
  ON "referral_points_exchanges"("target_subscription_id", "created_at");
CREATE INDEX "referral_points_exchanges_type_created_at_idx"
  ON "referral_points_exchanges"("type", "created_at");

ALTER TABLE "referral_points_exchanges"
  ADD CONSTRAINT "referral_points_exchanges_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_points_exchanges"
  ADD CONSTRAINT "referral_points_exchanges_target_subscription_id_fkey"
  FOREIGN KEY ("target_subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "referral_points_exchanges"
  ADD CONSTRAINT "referral_points_exchanges_gift_promocode_id_fkey"
  FOREIGN KEY ("gift_promocode_id") REFERENCES "promocodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "referral_points_exchanges"
  ADD CONSTRAINT "referral_points_exchanges_profile_sync_job_id_fkey"
  FOREIGN KEY ("profile_sync_job_id") REFERENCES "profile_sync_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
