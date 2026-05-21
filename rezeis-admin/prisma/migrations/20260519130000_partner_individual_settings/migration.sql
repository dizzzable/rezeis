-- Partner individual settings — donor parity with altshop's
-- `partner.individual_settings` JSON, but split into typed columns for
-- query-time efficiency and Prisma type safety.

CREATE TYPE "PartnerAccrualStrategy" AS ENUM (
  'ON_EACH_PAYMENT',
  'ONCE_PER_USER'
);

CREATE TYPE "PartnerRewardType" AS ENUM (
  'PERCENT',
  'FIXED'
);

ALTER TABLE "partners"
  ADD COLUMN "use_global_settings"   BOOLEAN                 NOT NULL DEFAULT TRUE,
  ADD COLUMN "accrual_strategy"      "PartnerAccrualStrategy" NOT NULL DEFAULT 'ON_EACH_PAYMENT',
  ADD COLUMN "reward_type"           "PartnerRewardType"      NOT NULL DEFAULT 'PERCENT',
  ADD COLUMN "level1_percent"        NUMERIC(5, 2),
  ADD COLUMN "level2_percent"        NUMERIC(5, 2),
  ADD COLUMN "level3_percent"        NUMERIC(5, 2),
  ADD COLUMN "level1_fixed_amount"   INTEGER,
  ADD COLUMN "level2_fixed_amount"   INTEGER,
  ADD COLUMN "level3_fixed_amount"   INTEGER;
