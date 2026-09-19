-- «Помощь с подключением»: the operator's switches (19.09.2026).
--
-- Shape `{ enabled?: boolean, delayHours?: number, includeTrials?: boolean }`;
-- absent keys mean OFF / 24 / OFF, so every existing install starts with the
-- automatic help switched off — an update must not start messaging customers
-- behind the operator's back. A column of its own rather than a key of
-- `user_notifications`: that map reads an absent key as ON and keeps booleans
-- only, so it can hold neither the default nor the hours.
--
-- A constant default on PostgreSQL 11+ is a catalogue change, not a table
-- rewrite, and "settings" is one row. `lock_timeout` bounds the wait for the
-- brief exclusive lock behind a long-running reader of the row. Timed out, the
-- next start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`), and `IF NOT EXISTS` makes the replay safe.

SET lock_timeout = '5s';

ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "connect_help_settings" JSONB NOT NULL DEFAULT '{}';

-- `migrate deploy` applies every pending migration over ONE connection, so a
-- session setting left behind here would bound every later file of the same
-- deploy to 5 s. The bound is this file's alone.
RESET lock_timeout;
