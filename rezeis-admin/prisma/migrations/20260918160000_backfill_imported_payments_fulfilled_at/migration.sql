-- Stamps the imported payments their donor bot had already settled.
--
-- A COMPLETED payment whose `fulfilled_at` is NULL reads as "paid, not
-- delivered yet" to everything that fulfils payments. The RemnaShop, AltShop
-- and STEALTHNET importers wrote every completed donor payment that way —
-- payments the donor had delivered long before — so imported add-on payments
-- filled the add-on recovery sweep's window and hid genuinely stranded ones,
-- the stranded-payment metrics counted them for ever, and a refund
-- notification for one of them was ignored. The importers stamp these rows now
-- (the donor's completion time, else its creation time); this stamps the rows
-- they had already written.
--
-- WHICH ROWS. COMPLETED, still unstamped, and carrying the import marker
-- `plan_snapshot.importedFrom`, which the four file importers write on every
-- transaction they create and nothing else writes on a transaction. 'bedolaga'
-- is on the list although its importer stamped every payment in every release
-- that shipped it: the webhook reconciler used to read an old stamp on a NEW
-- payment with no subscription — every imported payment — as an abandoned
-- checkout claim, cleared it, failed to provision against a plan the donor's
-- snapshot does not name, and left it cleared. The reconciler no longer acts on
-- imported payments at all; this puts back what it had already cleared.
--
-- WHY `created_at`. It is the donor's own date for the payment, as the importer
-- wrote it. RemnaShop and AltShop record nothing later (their importers stamp
-- exactly this now), and the completion time the other two donors had —
-- STEALTHNET's `paid_at`, Bedolaga's `completed_at` — was not kept on the row.
-- The payment was delivered by then or minutes after, and nothing reads the
-- stamp more finely than that.
--
-- WHY `updated_at` IS LEFT ALONE. Nothing about the payment has changed: the
-- stamp records what the donor did long ago. `updated_at` stays the moment the
-- panel last wrote the row — the import — rather than dating every imported
-- payment to the day this ran.
--
-- REPLAY. One statement, so an interrupted run commits nothing, and it only
-- touches rows that are still unstamped, so running it again changes nothing.
-- `lock_timeout` bounds the wait for the locks it needs — a row a live path is
-- writing at that moment, or the table behind a schema change — instead of
-- queueing everything that follows behind it. Timed out, the next start
-- replays this file (`is_auto_recoverable_migration` in `docker-entrypoint.sh`).
-- The bound is reset at the end: `migrate deploy` applies every pending file
-- over one connection, and a session setting left here would bind the files
-- after this one too.

SET lock_timeout = '5s';

UPDATE "transactions"
   SET "fulfilled_at" = "created_at"
 WHERE "status" = 'COMPLETED'
   AND "fulfilled_at" IS NULL
   AND "plan_snapshot"->>'importedFrom' IN ('bedolaga', 'remnashop', 'altshop', 'stealthnet');

RESET lock_timeout;
