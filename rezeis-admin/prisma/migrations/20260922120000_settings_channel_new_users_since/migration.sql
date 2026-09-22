-- «Проверять только новых» for «Канал обязателен» (22.09.2026).
--
-- NULL — the gate asks everyone, exactly as before this column existed, so an
-- update changes nothing until the operator turns the switch on. A moment —
-- the gate asks only accounts created at or after it; everyone older passes
-- every door (the bot, the Mini App, «Я подписался») as if the gate were off.
-- One nullable instant rather than a flag plus a date: a switch that is on
-- with no date to compare against is a state this column cannot hold.
--
-- A column with no default on PostgreSQL 11+ is a catalogue change, not a
-- table rewrite, and "settings" is one row. `lock_timeout` bounds the wait for
-- the brief exclusive lock behind a long-running reader of the row. Timed out,
-- the next start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`), and `IF NOT EXISTS` makes the replay safe.

SET lock_timeout = '5s';

ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "channel_new_users_since" TIMESTAMPTZ(3);

-- `migrate deploy` applies every pending migration over ONE connection, so a
-- session setting left behind here would bound every later file of the same
-- deploy to 5 s. The bound is this file's alone.
RESET lock_timeout;
