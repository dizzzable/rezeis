-- The unread total that now rides on every web push, and on every recipient of
-- a broadcast: `SELECT count(*) WHERE user_id = $1 AND read_at IS NULL`.
--
-- Neither existing index serves that pair. `user_notification_events_user_id_idx`
-- finds the person and then filters every row they have ever received in memory,
-- which is the wrong shape for a count that runs per push — and it degrades with
-- account age exactly where the row count is highest, because reading a
-- notification in the Telegram bot never stamps `read_at`.
--
-- CONCURRENTLY is deliberately NOT used: Prisma runs migrations inside a
-- transaction and `CREATE INDEX CONCURRENTLY` cannot run in one. The table is
-- small enough that a brief lock at deploy time is the cheaper trade.
CREATE INDEX IF NOT EXISTS "user_notification_events_user_id_read_at_idx"
  ON "user_notification_events" ("user_id", "read_at");
