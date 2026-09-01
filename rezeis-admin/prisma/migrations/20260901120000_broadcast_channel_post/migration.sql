-- The operator-channel copy of a broadcast becomes addressable.
--
-- WHAT WAS WRONG. A broadcast can be posted once to an operator-configured
-- Telegram channel in addition to the per-recipient fan-out. That post was
-- fire-and-forget: nothing recorded WHERE it went or WHICH message it became.
-- Every correction path therefore stopped at the recipients. Editing a sent
-- broadcast rewrote four hundred private messages and left the public channel
-- showing the original text; recalling one deleted it from four hundred chats
-- and left it on the channel, which is the copy anyone can still read. The
-- operator had no way to tell, and no way to fix it from the panel.
--
-- WHAT THESE COLUMNS BUY. The chat and the message id are the address of that
-- one post. With them the existing edit and recall paths reach it the same way
-- they reach a recipient's message — the panel already holds the bot token and
-- already calls editMessageText / deleteMessage directly for recipients, so
-- this needs nothing new from the bot.
--
-- BOTH NULLABLE, and null is the normal state: most broadcasts configure no
-- channel at all, and one sent before this migration has no id to recover.
-- Every reader treats null as "there is nothing to keep in step".

SET lock_timeout = '5s';

ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "channel_chat_id" TEXT;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "channel_message_id" BIGINT;

COMMENT ON COLUMN "broadcasts"."channel_chat_id" IS
  'Chat the operator-channel copy was posted to. NULL when the broadcast configured no channel.';
COMMENT ON COLUMN "broadcasts"."channel_message_id" IS
  'Telegram message id of the operator-channel copy, echoed by the bot on a confirmed relay. NULL when there is no post to keep in step (no channel, an unconfirmed delivery, or a broadcast sent before this column existed).';

-- ── AND THE INDEX THE NEW COUNTS NEED ───────────────────────────────────────
--
-- The broadcast list stopped deriving "still delivering" as
-- `total - success - failed` (which counts a recalled recipient as one still in
-- flight, for ever) and now COUNTS the PENDING and CANCELED rows per broadcast.
-- That is a grouped count over the 200 most recent broadcasts, re-run on every
-- poll of the screen — roughly every ten seconds while it is open.
--
-- `broadcast_messages` carried only single-column indexes on `broadcast_id` and
-- `status`, so that count could not be answered from an index and had to visit
-- heap rows. CANCELED rows never go away, so each recall would have added its
-- entire recipient count to a scan that repeats indefinitely.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the transaction
-- Prisma wraps a migration in, and this table is small enough that a brief lock
-- is the cheaper trade. `lock_timeout` above bounds the wait either way.
CREATE INDEX IF NOT EXISTS "broadcast_messages_broadcast_id_status_idx"
  ON "broadcast_messages" ("broadcast_id", "status");

RESET lock_timeout;
