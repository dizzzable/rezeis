-- Indexes the two columns that name a Remnawave profile, because they became
-- lookup keys and nothing noticed.
--
-- The previous migration (20260810120000) stated, correctly at the time, that
-- "neither column is a lookup key — both are read through the subscription row
-- that has already been selected by id". That stopped being true in the same
-- patch:
--
--   * `panelIdentityWhere` (remnawave-webhook.service.ts) resolves EVERY
--     incoming panel webhook by `remnawave_id`, and on 3.x by
--     `remnawave_id OR remnawave_panel_id` — a numeric identity has to match
--     both spellings because a profile created on 2.x still stores its uuid.
--     This is a per-event query on the busiest inbound path in the product.
--   * `ProfileSyncProcessor.panelProfileClaimedByAnother` asks "is anybody LIVE
--     on the profile this DELETE is about to address?" before every profile
--     deletion, over the same two columns.
--   * the four importers and two anti-fraud detectors match subscriptions by
--     `remnawave_id` (`= …` and `IN (…)`).
--   * `ExpiredProfileCleanupService` sweeps `remnawave_id IS NULL` per run.
--
-- Every one of those was a sequential scan over `subscriptions`.
--
-- FULL, NOT PARTIAL. Skipping the nulls would keep the index smaller, but the
-- cleanup sweep searches for exactly those nulls, and a full b-tree serves both
-- that and the equality lookups. It is also the shape Prisma can declare in
-- `schema.prisma`, so `migrate dev` cannot silently drop it — the partial
-- indexes in this repo (`ad_conversions_user_id_attributed_key`) live in SQL
-- only and have no such protection.
--
-- NOT UNIQUE, deliberately. A unique constraint is what this data SHOULD
-- satisfy — two subscriptions pointing at one panel profile is a defect — but
-- the importers have historically been able to produce duplicates from donor
-- dumps, and a migration that fails on live 2.7.4 data is exactly the failure
-- mode this integration cannot afford. The uniqueness question is answered in
-- application code, where it can report rather than abort. This index is the
-- part that is safe on any data set.
--
-- NOT CONCURRENTLY, and the reason first stated here was WRONG. It claimed
-- Prisma wraps each migration in a transaction, so `CREATE INDEX CONCURRENTLY`
-- could not run. It does not: `20260522140000_performance_indexes`, in this same
-- directory, contains seven of them and applies cleanly. Measured, not assumed.
--
-- The real reason is the interaction with `IF NOT EXISTS` above. A CONCURRENTLY
-- build that is interrupted — a deploy timeout, an OOM on a 512 MB container —
-- leaves the index behind marked INVALID. It exists, so every later run of this
-- migration skips it, and Postgres never uses it: a permanently dead index that
-- reports as present. A plain build either finishes or leaves nothing.
--
-- The cost of the plain build is a SHARE lock on `subscriptions` while it runs —
-- writes wait, reads do not. Measured on 300k rows: 216 + 79 + 186 ms, about
-- half a second for all three, plus ~30 MB. Single-CPU VPS with the default
-- `maintenance_work_mem`: seconds, not minutes.
--
-- `lock_timeout` is what makes that bound real. ACQUIRING the lock is unbounded
-- even though HOLDING it is brief: the hourly `pg_dump` cron holds ACCESS SHARE
-- on every table for the length of the dump, and an index build queued behind it
-- blocks every reader that arrives after it. Five seconds, then fail — a failed
-- migration retries (both migrations here are idempotent and listed in
-- `is_auto_recoverable_migration`), whereas a queued one takes the product down
-- with it.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "subscriptions_remnawave_id_idx"
  ON "subscriptions" ("remnawave_id");

CREATE INDEX IF NOT EXISTS "subscriptions_remnawave_panel_id_idx"
  ON "subscriptions" ("remnawave_panel_id");

-- The third one exists for a single query, and that query runs before every
-- profile deletion: `ProfileSyncProcessor.panelProfileClaimedByAnother` asks
-- whether the panel username a DELETE might resolve by has since come to belong
-- to a LIVE subscription. Deletions arrive in batches from the expired-profile
-- sweep, so an unindexed column here is one sequential scan per doomed row.
CREATE INDEX IF NOT EXISTS "subscriptions_remnawave_panel_username_idx"
  ON "subscriptions" ("remnawave_panel_username");

-- Back to the server default, so the setting cannot leak into whatever this
-- connection runs next: Prisma does not open a transaction per migration, so
-- `SET LOCAL` would have nothing to scope to and a plain `SET` outlives the file.
SET lock_timeout = 0;
