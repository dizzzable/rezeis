-- Per-level partner accrual strategy.
--
-- The rates were already per level (`level1_percent`, `level1_fixed_amount`,
-- ...). The MODE was not: `accrual_strategy` answered "every payment" or
-- "first payment only" once, for the whole partner, and every level obeyed
-- that one answer. These three columns move the mode to the same per-level
-- shape the rates already have, so a partner can earn on every payment from
-- their own referrals (L1) while earning only on the first payment from a
-- sub-partner's referrals (L2/L3).
--
-- WHY NULLABLE, AND WHY NOTHING IS BACKFILLED. NULL is a value here, not a
-- gap: it means "inherit `accrual_strategy`", the partner-wide column that
-- already exists and already holds the right answer for every live row. So
-- the day this ships, every existing partner keeps behaving EXACTLY as it
-- does today, at all three levels, by construction rather than by a data
-- migration that has to be right. A backfill would also freeze the answer:
-- an operator who later flips the partner-wide `accrual_strategy` would see
-- the copied per-level values ignore the flip and the partner silently
-- diverge from what its own toggle says. Inheritance keeps them in step.
--
-- NO DEFAULT, deliberately. A `DEFAULT` would apply to rows INSERTed by code
-- that never mentions these columns, quietly pinning new partners to a fixed
-- mode instead of tracking their own `accrual_strategy`.
--
-- LIVE SAFETY. `ADD COLUMN` of an existing enum type with no default and no
-- NOT NULL is catalog-only on PostgreSQL 11+: no table rewrite, no row read,
-- `relfilenode` unchanged. Same shape as 20260810120000, which was measured
-- at 3 ms on a populated copy. `partners` is far smaller than `subscriptions`.
--
-- The three milliseconds are not the risk (see 20260810120000): ACCESS
-- EXCLUSIVE queues behind every open transaction on the table, and once it is
-- queued every later reader queues behind IT -- the hourly `pg_dump` alone is
-- long enough to turn this into a pool-exhausting stall. So wait five seconds
-- for the lock, then fail. Every statement is `IF NOT EXISTS`, so this file is
-- safe to replay in full after a partial application.
SET lock_timeout = '5s';

ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "level1_accrual_strategy" "PartnerAccrualStrategy";
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "level2_accrual_strategy" "PartnerAccrualStrategy";
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "level3_accrual_strategy" "PartnerAccrualStrategy";

-- Back to the server default; Prisma opens no transaction per migration, so a
-- plain `SET` would outlive this file on the same connection.
SET lock_timeout = 0;

COMMENT ON COLUMN "partners"."level1_accrual_strategy" IS
  'Accrual mode for level-1 earnings. NULL inherits partners.accrual_strategy (the pre-existing partner-wide column). Only read when use_global_settings is false.';
COMMENT ON COLUMN "partners"."level2_accrual_strategy" IS
  'Accrual mode for level-2 earnings. NULL inherits partners.accrual_strategy. Only read when use_global_settings is false.';
COMMENT ON COLUMN "partners"."level3_accrual_strategy" IS
  'Accrual mode for level-3 earnings. NULL inherits partners.accrual_strategy. Only read when use_global_settings is false.';
