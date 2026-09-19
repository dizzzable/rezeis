-- «Купил, но не подключился»: whether a subscription's VPN profile ever
-- connected, per SUBSCRIPTION (19.09.2026).
--
-- `users.first_traffic_at` answers "has this person used traffic on some
-- profile, ever", which says "connected" for a second subscription bought for
-- another device the moment the first one connected. So the fact lives here,
-- one row per subscription, keyed by it:
--
--   first_connected_at   the earliest evidence of traffic. Only ever lowered,
--                        never cleared (`LEAST` in one upsert, so replays and
--                        out-of-order writers cannot move it later).
--   checked_at           the last successful read of the profile that carried a
--                        traffic block — the verification clock. Only moves
--                        forward (`GREATEST`).
--   check_failures,      the probe's backoff and the panel's own
--   profile_missing_at   USER_NOT_FOUND.
--   help_* ,             the once-per-subscription «Помощь с подключением»
--   banner_dismissed_at  decision, written only through guarded claims.
--
-- A missing row means "we know nothing", never "not connected". Every
-- existing subscription starts without one; the webhook, the cabinet's own
-- profile read and the worker's probe fill it in.
--
-- WHY A TABLE AND NOT COLUMNS ON "subscriptions": a probe stamp there would
-- bump `subscriptions.updated_at`, and the webhook picks among duplicate rows
-- of one profile by exactly that column; and "subscriptions" is the hot table
-- with a BEFORE UPDATE trigger, which this leaves alone. No `user_id`: an
-- account merge moves the subscription and this row follows it.
--
-- ── Live safety ─────────────────────────────────────────────────────────────
--
-- The table is new and empty, so its one index costs nothing and needs no
-- CONCURRENTLY. The foreign key takes a brief SHARE ROW EXCLUSIVE on
-- "subscriptions"; behind the hourly `pg_dump` it would otherwise queue every
-- purchase behind itself, so `lock_timeout` bounds the wait. Timed out, the
-- next start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`), and every statement is guarded, so the replay is
-- a no-op for whatever already exists. `updated_at` carries no default, like
-- every other table here: the writer supplies it.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "subscription_connect_states" (
    "subscription_id" TEXT NOT NULL,
    "first_connected_at" TIMESTAMPTZ(3),
    "connected_source" TEXT,
    "checked_at" TIMESTAMPTZ(3),
    "check_failures" INTEGER NOT NULL DEFAULT 0,
    "profile_missing_at" TIMESTAMPTZ(3),
    "help_decided_at" TIMESTAMPTZ(3),
    "help_kind" TEXT,
    "help_anchor_at" TIMESTAMPTZ(3),
    "help_source" TEXT,
    "help_outcome" TEXT,
    "help_attempts" JSONB NOT NULL DEFAULT '[]',
    "help_deferrals" INTEGER NOT NULL DEFAULT 0,
    "help_event_id" TEXT,
    "banner_dismissed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_connect_states_pkey" PRIMARY KEY ("subscription_id")
);

-- The sender's log, newest decision first.
CREATE INDEX IF NOT EXISTS "subscription_connect_states_help_decided_at_idx"
  ON "subscription_connect_states"("help_decided_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscription_connect_states_subscription_id_fkey'
  ) THEN
    ALTER TABLE "subscription_connect_states"
      ADD CONSTRAINT "subscription_connect_states_subscription_id_fkey"
      FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- `migrate deploy` applies every pending migration over ONE connection, so a
-- session setting left behind here would bound every later file of the same
-- deploy to 5 s. The bound is this file's alone.
RESET lock_timeout;
