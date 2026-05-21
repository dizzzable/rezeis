-- Replaces the single `media_url` slot with a `media_urls` text[] so a
-- FAQ entry can carry an ordered set of attachments (images or videos).
-- Existing single-URL rows are preserved by promoting their value into
-- a one-element array; nulls become an empty array.

ALTER TABLE "faq_items"
  ADD COLUMN "media_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "faq_items"
  SET "media_urls" = ARRAY["media_url"]
  WHERE "media_url" IS NOT NULL AND "media_url" <> '';

ALTER TABLE "faq_items" DROP COLUMN "media_url";
