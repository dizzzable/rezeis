ALTER TABLE "subscriptions" ADD COLUMN "remnawave_user_id" INTEGER;

CREATE INDEX "subscriptions_remnawave_user_id_idx" ON "subscriptions"("remnawave_user_id");
