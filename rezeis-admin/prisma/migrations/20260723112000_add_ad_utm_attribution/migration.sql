-- Persist UTM attribution captured at click time and copied to conversions.
-- Additive and safe for environments where a column was introduced manually.
ALTER TABLE "ad_clicks"
  ADD COLUMN IF NOT EXISTS "utm_source" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_medium" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_campaign" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_content" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_creative" TEXT;

CREATE INDEX IF NOT EXISTS "ad_clicks_utm_source_idx" ON "ad_clicks"("utm_source");
CREATE INDEX IF NOT EXISTS "ad_clicks_utm_medium_idx" ON "ad_clicks"("utm_medium");
CREATE INDEX IF NOT EXISTS "ad_clicks_utm_campaign_idx" ON "ad_clicks"("utm_campaign");

ALTER TABLE "ad_conversions"
  ADD COLUMN IF NOT EXISTS "utm_source" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_medium" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_campaign" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_content" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_creative" TEXT;
