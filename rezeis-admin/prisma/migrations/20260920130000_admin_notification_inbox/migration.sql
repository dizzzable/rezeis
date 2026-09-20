-- The panel's notification centre (20.09.2026): the alerts an operator was
-- given, kept instead of shown once and lost.
--
-- Until now an alert existed for as long as its toast: the socket delivered it
-- to whoever had the panel open at that second, web push delivered it to
-- whoever had subscribed a device, and nothing wrote it down. An operator who
-- was away simply never learned of it.
--
-- A ROW PER ADMIN, not per event. «Прочитано» and «удалить» belong to one
-- operator, and the permission gate runs once — when the event is raised, by
-- the same route table that decides who gets the push. So this table holds
-- copies, and deleting one takes nothing away from anyone else.
--
-- A new, empty table: nothing is backfilled, and nothing reads it until the
-- panel grows the bell. Replay-safe throughout, so a start that timed out on
-- the lock re-applies it (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`). The foreign key briefly locks "admin_users";
-- `lock_timeout` bounds that wait.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "admin_notifications" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "admin_notifications_admin_id_created_at_idx"
  ON "admin_notifications"("admin_id", "created_at");

CREATE INDEX IF NOT EXISTS "admin_notifications_admin_id_read_at_idx"
  ON "admin_notifications"("admin_id", "read_at");

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_notifications_admin_id_fkey'
  ) THEN
    ALTER TABLE "admin_notifications"
      ADD CONSTRAINT "admin_notifications_admin_id_fkey"
      FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

-- The session outlives this file, so the bound comes off with the work it was
-- taken for; whatever migration runs next takes its own decision.
RESET lock_timeout;
