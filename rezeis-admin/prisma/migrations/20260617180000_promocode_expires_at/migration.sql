-- Absolute expiry timestamp for promocodes (operator picks an exact date+time
-- in the configurator). Takes precedence over the relative `lifetime` (days)
-- when set; null keeps the existing lifetime-based / unlimited behavior.
ALTER TABLE "promocodes"
  ADD COLUMN "expires_at" timestamptz(3);
