-- AdminThemePreset: persisted custom themes saved by admin operators.
-- Owner is the admin who created it. When `is_shared = true`, every
-- admin can read/apply it; only the owner (or any DEV) can delete.
CREATE TABLE "admin_theme_presets" (
  "id"          TEXT PRIMARY KEY,
  "owner_id"    TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "is_shared"   BOOLEAN NOT NULL DEFAULT FALSE,
  "theme_data"  JSONB NOT NULL,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX "admin_theme_presets_owner_id_idx" ON "admin_theme_presets" ("owner_id");
CREATE INDEX "admin_theme_presets_is_shared_idx" ON "admin_theme_presets" ("is_shared");

ALTER TABLE "admin_theme_presets"
  ADD CONSTRAINT "admin_theme_presets_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "admin_users"("id") ON DELETE CASCADE;
