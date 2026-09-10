-- The event catalogue groups `admin_audit_log` by `action` inside a retention
-- window, to answer "has this event ever fired on this installation".
--
-- Neither existing index can serve it. `(action)` alone cannot be range-scanned
-- by `created_at`, and a plain btree on a text column cannot answer
-- `LIKE 'event.%'` at all unless the cluster collates as C or POSIX — stock
-- `postgres:17-alpine`, which the compose file uses, does not. The planner
-- therefore chose a sequential scan of the busiest table in the schema, on a
-- page an operator opens whenever they edit a rule.
--
-- CONCURRENTLY so an install with millions of audit rows does not take a write
-- lock on that table for the length of the build — the same choice
-- `20260522140000_performance_indexes` makes for the same reason. `IF NOT
-- EXISTS` keeps a re-run cheap; an interrupted build leaves the index INVALID
-- and it has to be dropped by hand before this will replace it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "admin_audit_log_action_created_at_idx"
  ON "admin_audit_log" ("action", "created_at");
