-- «Доп. услуги» → «Настройки»: the switches of the durable add-on model
-- (24.09.2026). They replace the `ADDON_*` environment variables as the place
-- an operator turns a stage on or off; an explicit variable in `.env` still
-- wins over the stored value.
--
-- Shape `{ durableAccounting?: boolean, deviceCleanupAuto?: boolean,
-- trafficResetExpiry?: boolean }`, sparse: `{}` means every switch is at its
-- default (`ADD_ON_SWITCH_DEFAULTS`), so every existing install keeps running
-- exactly what it ran before this column existed.
--
-- A constant default on PostgreSQL 11+ is a catalogue change, not a table
-- rewrite, and "settings" is one row. `lock_timeout` bounds the wait for the
-- brief exclusive lock behind a long-running reader of the row. Timed out, the
-- next start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`), and `IF NOT EXISTS` makes the replay safe.

SET lock_timeout = '5s';

ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "add_on_settings" JSONB NOT NULL DEFAULT '{}';

-- `migrate deploy` applies every pending migration over ONE connection, so a
-- session setting left behind here would bound every later file of the same
-- deploy to 5 s. The bound is this file's alone.
RESET lock_timeout;
