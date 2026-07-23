-- A May performance migration created a partial ACTIVE-only index using the
-- same name that Prisma later assigned to the full `status, expires_at` index.
-- The July migration therefore failed with `relation already exists`; its
-- later `IF NOT EXISTS` hardening made deploys repeatable, but could not change
-- the already-existing partial definition.
--
-- Build the desired full index under a staging name before replacing the old
-- one. `CONCURRENTLY` keeps writes available, and the initial staging-index
-- drop makes every intermediate state safe to retry after `migrate resolve`.

SET statement_timeout = 0;
SET lock_timeout = 0;

DROP INDEX CONCURRENTLY IF EXISTS "subscriptions_status_expires_at_rebuild_idx";

CREATE INDEX CONCURRENTLY "subscriptions_status_expires_at_rebuild_idx"
  ON "subscriptions" ("status", "expires_at");

DROP INDEX CONCURRENTLY IF EXISTS "subscriptions_status_expires_at_idx";

ALTER INDEX "subscriptions_status_expires_at_rebuild_idx"
  RENAME TO "subscriptions_status_expires_at_idx";
