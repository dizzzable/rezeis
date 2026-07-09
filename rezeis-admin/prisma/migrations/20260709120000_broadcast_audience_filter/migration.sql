-- Structured, multi-select broadcast audience filter. Additive + nullable:
-- legacy drafts keep NULL and fall back to the `audience` enum preset, so this
-- changes no existing behavior and needs no backfill. IF NOT EXISTS keeps a
-- re-apply safe (idempotent) after a rolled-back failed migration.

ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "audience_filter" JSONB;
