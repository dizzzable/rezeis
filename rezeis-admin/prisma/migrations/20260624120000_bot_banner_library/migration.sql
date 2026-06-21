-- Bot Studio Constructor W3: per-notification banner + reusable banner library.

-- Per-notification banner image (nullable; null = text-only delivery as today).
ALTER TABLE "notification_templates" ADD COLUMN "banner_url" TEXT;

-- Reusable banner library — upload once, assign by URL to screens / notifications.
CREATE TABLE "bot_banners" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "bot_banners_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_banners_created_at_idx" ON "bot_banners" ("created_at");
