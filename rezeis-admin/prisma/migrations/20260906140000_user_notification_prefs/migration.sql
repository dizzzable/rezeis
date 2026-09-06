-- Per-subscriber notification opt-outs.
--
-- Nullable and with no default: an absent column value means "nothing opted
-- out", which is what every existing row must keep meaning. Backfilling `{}`
-- would say the same thing at the cost of rewriting the table.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notification_prefs" JSONB;
