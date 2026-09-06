-- Attachments whose bytes were deleted to reclaim disk.
--
-- Nullable with no default: every existing row has its file, which is
-- exactly what a NULL means here.
ALTER TABLE "support_attachments" ADD COLUMN IF NOT EXISTS "purged_at" TIMESTAMPTZ(3);
