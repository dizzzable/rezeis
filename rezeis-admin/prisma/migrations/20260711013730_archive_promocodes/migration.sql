-- Archive promocodes instead of hard-deleting rows referenced by activation
-- history. Additive and nullable: existing rows remain visible and active.
ALTER TABLE "promocodes"
  ADD COLUMN "archived_at" TIMESTAMPTZ(3);

-- Supports the admin list's active archive filter and newest-first ordering.
CREATE INDEX "promocodes_archived_at_created_at_idx"
  ON "promocodes"("archived_at", "created_at");
