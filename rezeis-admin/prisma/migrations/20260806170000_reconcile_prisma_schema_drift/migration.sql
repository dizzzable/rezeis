-- Reconcile the database with prisma/schema.prisma so `migrate dev` stops
-- proposing an unrequested migration.
--
-- Drift had accumulated silently since 2026-05-18, contributed by seven
-- separate migrations: `migrate diff` against a database built from the full
-- history reported an enum rewrite, six dropped indexes, three dropped
-- defaults and four foreign-key changes. Most of it was
-- the SCHEMA being wrong and has been fixed there (a `TransactionStatus` value
-- lost to a bad diff hunk, a missing `@default([])`, and six hand-written
-- performance indexes that were never declared). What remains here is the part
-- where the DATABASE is the outlier, and each item is catalog-only: no table is
-- rewritten, no row is read, and nothing is validated except one tiny admin
-- table. There is no `CONCURRENTLY` because no index is built or dropped.
--
-- Every statement is individually guarded, so this file is safe to replay in
-- full after a partial application.

-- 1. `updated_at` carries no database default anywhere else in this schema.
-- 59 tables leave the column bare and let Prisma's `@updatedAt` supply the
-- value on every write; these three picked up a `DEFAULT CURRENT_TIMESTAMP`
-- from hand-written DDL. None of the 62 `@updatedAt` fields in the schema
-- declares `@default`, so the schema is the correct side. Dropping a default
-- is a catalog edit — no rewrite, no scan — and nothing inserts into these
-- tables with raw SQL, so no writer depends on the default being there.
ALTER TABLE "admin_theme_presets" ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE "auth_provider_configs" ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE "trial_claims" ALTER COLUMN "updated_at" DROP DEFAULT;

-- 2. Two composite foreign keys on `add_on_entitlements` were created with
-- hand-picked short names. Prisma derives the name from the referencing
-- columns, so it sees a stranger and proposes to rename on every diff. The
-- constraints themselves are already correct — only the label is wrong.
-- `RENAME CONSTRAINT` is catalog-only: it revalidates nothing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'add_on_entitlements_expiry_epoch_term_fkey'
      AND conrelid = 'public.add_on_entitlements'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'add_on_entitlements_expiry_epoch_id_term_id_fkey'
      AND conrelid = 'public.add_on_entitlements'::regclass
  ) THEN
    ALTER TABLE "add_on_entitlements"
      RENAME CONSTRAINT "add_on_entitlements_expiry_epoch_term_fkey"
                     TO "add_on_entitlements_expiry_epoch_id_term_id_fkey";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'add_on_entitlements_term_subscription_fkey'
      AND conrelid = 'public.add_on_entitlements'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'add_on_entitlements_term_id_subscription_id_fkey'
      AND conrelid = 'public.add_on_entitlements'::regclass
  ) THEN
    ALTER TABLE "add_on_entitlements"
      RENAME CONSTRAINT "add_on_entitlements_term_subscription_fkey"
                     TO "add_on_entitlements_term_id_subscription_id_fkey";
  END IF;
END $$;

-- 3. `add_on_entitlements_term_id_fkey` (term_id -> subscription_terms.id) is
-- provably redundant and is dropped rather than added to the schema, because
-- modelling it would mean a second Prisma relation field to the same table.
-- The composite FK kept above already references
-- `subscription_terms(id, subscription_id)`, and `subscription_terms_pkey` is
-- UNIQUE on `id` alone — so exactly one row exists per id, and a matching pair
-- already proves `term_id` resolves. Both constraints are ON DELETE RESTRICT,
-- so deleting a term stays blocked by the composite one; referential
-- protection is unchanged. `term_id` and `subscription_id` are both NOT NULL,
-- so there is no NULL path that skips the composite check. Dropping a
-- constraint is catalog-only, and the `add_on_entitlements_term_id_state_idx`
-- index that serves term lookups is untouched.
ALTER TABLE "add_on_entitlements"
  DROP CONSTRAINT IF EXISTS "add_on_entitlements_term_id_fkey";

-- 4. `admin_theme_presets_owner_id_fkey` was written by hand with an explicit
-- ON DELETE but no ON UPDATE clause, so PostgreSQL defaulted it to NO ACTION
-- while every Prisma-generated foreign key in this database uses CASCADE.
-- `admin_users.id` is a cuid that is never updated, so the two behave
-- identically today; this aligns the label so the diff stops reporting it.
-- Re-creating a foreign key does validate existing rows, but
-- `admin_theme_presets` holds at most a handful of presets per admin, so the
-- scan is trivial. The guard checks the ON UPDATE action itself, so a replay
-- skips the work entirely instead of dropping and revalidating a second time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_theme_presets_owner_id_fkey'
      AND conrelid = 'public.admin_theme_presets'::regclass
      AND confupdtype = 'c'
  ) THEN
    ALTER TABLE "admin_theme_presets"
      DROP CONSTRAINT IF EXISTS "admin_theme_presets_owner_id_fkey";

    ALTER TABLE "admin_theme_presets"
      ADD CONSTRAINT "admin_theme_presets_owner_id_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "admin_users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
