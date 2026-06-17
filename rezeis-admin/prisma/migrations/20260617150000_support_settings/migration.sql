-- Panel-managed anonymous support chat settings (enabled flag, guest token
-- TTL, attachment caps, Turnstile keys). JSON column on the singleton row;
-- env vars only seed defaults.

ALTER TABLE "settings" ADD COLUMN "support_settings" JSONB NOT NULL DEFAULT '{}';
