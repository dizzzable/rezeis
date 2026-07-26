-- Reporting exchange rates. `MANUAL` rows are operator decisions (Telegram Stars
-- has no market price) and are never overwritten by the hourly refresh.
CREATE TABLE IF NOT EXISTS "fx_rates" (
    "id" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DECIMAL(30,12) NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fx_rates_base_quote_key" ON "fx_rates"("base", "quote");

-- Revenue in the reporting base currency, fixed at the rate that held when the
-- conversion was recorded. Reports sum this column instead of adding raw minor
-- units across 14 currencies; NULL means "no rate was available", which is
-- reported as unconverted rather than counted as zero.
ALTER TABLE "ad_conversions" ADD COLUMN IF NOT EXISTS "amount_base" INTEGER;
ALTER TABLE "ad_conversions" ADD COLUMN IF NOT EXISTS "base_currency" TEXT;
ALTER TABLE "ad_conversions" ADD COLUMN IF NOT EXISTS "fx_rate" DECIMAL(30,12);

-- Backfill the rows that need no conversion: a RUB conversion is already in the
-- default base currency, so payback figures survive the upgrade unchanged.
UPDATE "ad_conversions"
   SET "amount_base" = "amount",
       "base_currency" = 'RUB',
       "fx_rate" = 1
 WHERE "currency" = 'RUB'
   AND "amount_base" IS NULL;
