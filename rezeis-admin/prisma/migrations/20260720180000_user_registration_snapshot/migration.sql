-- Write-once registration network snapshot (UTM / Referer / IP / UA).
-- Additive only — historical rows stay NULL.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_ip" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_user_agent" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_referer" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_utm" JSONB;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_channel" TEXT;

CREATE INDEX IF NOT EXISTS "users_registration_ip_idx" ON "users"("registration_ip");
