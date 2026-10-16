-- The AI assistant answers inside support tickets (16.10.2026). The separate
-- AI chat of the cabinet and the bot is retired; a ticket says whether the
-- assistant still leads it, and if not, since when and why a human does.
--
--   ai_active          the assistant answers this thread. Set when a cabinet
--                      ticket is opened while the assistant is on and has a
--                      key; cleared by an operator's own message, by the
--                      operator's switch on the ticket, and by a hand-over.
--                      Every existing ticket starts at false: no thread an
--                      operator already owns is handed to the assistant.
--   ai_handed_off_at   when the assistant passed the thread to a human — the
--                      moment the operators were told. NULL while it never did.
--   ai_handoff_reason  why, in the assistant's words or the panel's own code
--                      (`ai_error`, `ai_off`, `ai_limit`).
--
-- The assistant's replies are ordinary ADMIN messages marked `{"ai": true}` in
-- `metadata`, NOT a new author type: a release that does not know the mark
-- (a panel rolled back to 0.9.7.75, any cabinet) reads them as support replies
-- instead of failing on an enum value it has never seen.
--
-- LIVE DATABASE. A NOT NULL column with a constant default and two nullable
-- ones are catalogue changes on PostgreSQL 11+, not a table rewrite. Timed
-- out, the next start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`): `IF NOT EXISTS` makes the replay change nothing that
-- already landed.

SET lock_timeout = '5s';

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "ai_active" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "ai_handed_off_at" TIMESTAMPTZ(3);

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "ai_handoff_reason" TEXT;

-- The bound is this file's alone: `migrate deploy` applies every pending
-- migration over one connection.
RESET lock_timeout;
