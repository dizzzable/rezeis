-- Signing a customer's other cabinet sessions out when their password changes.
--
-- A cabinet session is an opaque key in the cabinet's Redis with no index by
-- customer, so a password reset, a password change or a first password used to
-- leave every session opened before it alive for the rest of its 30-day
-- window — including the one of whoever the change was meant to lock out. This
-- column is the moment before which every session of the account is signed
-- out. The cabinet compares it with each session's start, at most once a
-- minute per session, and ends the older ones; the browser that made the
-- change gets a fresh session that starts after it.
--
-- WHY IN POSTGRES AND NOT IN THE CABINET'S REDIS. A revocation must not be
-- forgotten. A Redis key can be evicted under memory pressure or lost with an
-- unpersisted restart, and a lost revocation silently brings back every
-- session it ended. Lost here, it cannot be.
--
-- Written by: a password reset (any channel), a password change, a first
-- password set from the Mini App, and «Выйти на всех устройствах». NULL means
-- no session of the account was ever signed out this way, which is what every
-- existing row starts as.
--
-- Nullable, no default: a catalogue change on "web_accounts", no table
-- rewrite, and nothing reads it until a cabinet that knows about it asks.
-- `lock_timeout` bounds the wait for the brief exclusive lock the change needs:
-- behind a long-running reader of "web_accounts" it would otherwise queue every
-- sign-in behind itself for as long as that reader runs. Timed out, the next
-- start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`), and `IF NOT EXISTS` makes the replay safe.

SET lock_timeout = '5s';

ALTER TABLE "web_accounts" ADD COLUMN IF NOT EXISTS "sessions_revoked_at" TIMESTAMPTZ(3);
