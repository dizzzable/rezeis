-- A May performance migration created a partial ACTIVE-only index using the
-- same name that Prisma later assigned to the full `status, expires_at` index.
-- The July migration therefore failed with `relation already exists`; its
-- later `IF NOT EXISTS` hardening made deploys repeatable, but could not change
-- the already-existing partial definition.
--
-- Build the desired full index under a staging name without blocking writes.
-- Keep this migration to exactly one SQL statement: PostgreSQL rejects
-- concurrent index DDL when a migration runner sends it as a multi-command
-- transaction. The following migrations remove the conflicting name and
-- perform the fast metadata-only swap.
CREATE INDEX CONCURRENTLY "subscriptions_status_expires_at_rebuild_idx"
  ON "subscriptions" ("status", "expires_at");
