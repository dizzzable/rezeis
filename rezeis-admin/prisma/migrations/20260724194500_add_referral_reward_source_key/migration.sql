-- Preserve a stable source-ledger key for idempotent referral reward imports.
ALTER TABLE "referral_rewards"
ADD COLUMN "source_key" TEXT;

CREATE UNIQUE INDEX "referral_rewards_source_key_key"
ON "referral_rewards"("source_key");
