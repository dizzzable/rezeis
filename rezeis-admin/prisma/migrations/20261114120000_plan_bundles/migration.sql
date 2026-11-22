-- Merged subscription links (14.11.2026): a subscriber who holds several
-- subscriptions at once should be able to connect to all of them through ONE
-- config URL, without the Remnawave panel learning a new trick.
--
-- The panel hands out one subscription URL per profile, and rezeis creates one
-- profile per subscription, so "all of it in one link" has to live between the
-- two services:
--
--   cabinet -> https://<merge host>/merge/<token>
--                -> remnawave-subscription-merge
--                     -> this service: which profiles does <token> stand for?
--                     -> the panel's own public subscription URLs, merged
--
--   plan_bundles            the operator's grouping: «Unlimited + Лимитный».
--                           NOT a product — no price, no duration, no checkout.
--                           Buying still creates subscriptions the way it
--                           always did; the bundle only decides which cards
--                           offer the same merged link.
--   plan_bundle_members     which plans are in it. UNIQUE(plan_id): a plan
--                           belongs to at most one bundle, because two bundles
--                           overlapping on a plan would make "which link does
--                           this card show" ambiguous.
--   subscription_merge_links  one row per (user, bundle): the token itself,
--                           made on first need and kept across renewals so the
--                           customer's saved URL keeps working. `revoked_at`
--                           retires a link without losing who had it.
--
-- Three new, empty tables. Nothing is backfilled and nothing reads them until
-- an operator creates a bundle, so the deploy changes no existing behaviour.
-- Replay-safe throughout: a start that timed out on the lock re-applies this
-- file (`is_auto_recoverable_migration` in `docker-entrypoint.sh`). The foreign
-- keys briefly lock "users" and "plans"; `lock_timeout` bounds that wait.

SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "plan_bundles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "plan_bundle_members" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,

    CONSTRAINT "plan_bundle_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "subscription_merge_links" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_merge_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "plan_bundles_name_key" ON "plan_bundles"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "plan_bundles_is_active_idx" ON "plan_bundles"("is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "plan_bundles_order_index_idx" ON "plan_bundles"("order_index");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "plan_bundle_members_plan_id_key"
  ON "plan_bundle_members"("plan_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "plan_bundle_members_bundle_id_idx"
  ON "plan_bundle_members"("bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_merge_links_token_key"
  ON "subscription_merge_links"("token");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_merge_links_user_id_bundle_id_key"
  ON "subscription_merge_links"("user_id", "bundle_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subscription_merge_links_bundle_id_idx"
  ON "subscription_merge_links"("bundle_id");

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_bundle_members_bundle_id_fkey'
  ) THEN
    ALTER TABLE "plan_bundle_members"
      ADD CONSTRAINT "plan_bundle_members_bundle_id_fkey"
      FOREIGN KEY ("bundle_id") REFERENCES "plan_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_bundle_members_plan_id_fkey'
  ) THEN
    ALTER TABLE "plan_bundle_members"
      ADD CONSTRAINT "plan_bundle_members_plan_id_fkey"
      FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscription_merge_links_user_id_fkey'
  ) THEN
    ALTER TABLE "subscription_merge_links"
      ADD CONSTRAINT "subscription_merge_links_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscription_merge_links_bundle_id_fkey'
  ) THEN
    ALTER TABLE "subscription_merge_links"
      ADD CONSTRAINT "subscription_merge_links_bundle_id_fkey"
      FOREIGN KEY ("bundle_id") REFERENCES "plan_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

-- The session outlives this file, so the bound comes off with the work it was
-- taken for; whatever migration runs next takes its own decision.
RESET lock_timeout;
