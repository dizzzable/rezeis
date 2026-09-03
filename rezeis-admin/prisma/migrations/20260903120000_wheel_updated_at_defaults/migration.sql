-- `updated_at` carries no database default anywhere in this schema.
--
-- Sixty-odd tables leave the column bare and let Prisma's `@updatedAt` supply
-- the value on every write, and NONE of the `@updatedAt` fields in
-- `schema.prisma` declares a `@default` — so the schema is the correct side
-- and a database default is drift. `20260806170000_reconcile_prisma_schema_drift`
-- exists for exactly this reason, and undid it on the last three tables that
-- had picked one up from hand-written DDL.
--
-- Three tables in this release did it again: `wheel_key_pools` and
-- `wheel_sectors` (20260902180000) and `contests` (20260903090000). Left
-- alone, the next `prisma migrate dev` proposes three `DROP DEFAULT`
-- statements and the reconciliation migration's premise is false a second
-- time.
--
-- Done in a NEW file rather than by editing those two, because Prisma records
-- a checksum of every migration it has applied: editing an applied file makes
-- `migrate deploy` refuse to run at all on any database that already has it.
--
-- Dropping a default is a catalog edit — no table rewrite, no scan, no
-- validation — and nothing inserts into these tables with raw SQL, so no
-- writer depends on the default being there. Every statement is guarded, so
-- the file is safe to replay in full after a partial application.

SET lock_timeout = '5s';

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wheel_key_pools') THEN
    ALTER TABLE "wheel_key_pools" ALTER COLUMN "updated_at" DROP DEFAULT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wheel_sectors') THEN
    ALTER TABLE "wheel_sectors" ALTER COLUMN "updated_at" DROP DEFAULT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contests') THEN
    ALTER TABLE "contests" ALTER COLUMN "updated_at" DROP DEFAULT;
  END IF;
END
$do$;

RESET lock_timeout;
