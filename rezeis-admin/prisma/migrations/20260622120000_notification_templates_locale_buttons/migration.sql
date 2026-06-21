-- Phase 1 of the bot-studio-redesign spec:
-- give NotificationTemplate an EN locale and a data-driven action-button list
-- so notification copy + buttons (e.g. the expiry "Продлить" Mini App
-- button) can be edited from the new "Карта бота" module instead of being
-- hard-coded. Defaults preserve current behaviour: empty EN columns fall
-- back to the RU column at delivery time, and `buttons = '[]'` keeps the
-- previous "no extra buttons" wire shape until the seed re-runs.
ALTER TABLE "notification_templates"
  ADD COLUMN IF NOT EXISTS "title_en" TEXT,
  ADD COLUMN IF NOT EXISTS "body_en"  TEXT,
  ADD COLUMN IF NOT EXISTS "buttons"  JSONB NOT NULL DEFAULT '[]'::jsonb;
