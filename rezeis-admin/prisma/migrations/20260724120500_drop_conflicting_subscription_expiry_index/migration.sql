-- The replacement index is already valid and available to PostgreSQL's query
-- planner under its staging name. Remove the conflicting canonical name in a
-- standalone non-blocking statement before the metadata-only rename.

DROP INDEX CONCURRENTLY IF EXISTS "public"."subscriptions_status_expires_at_idx";
