-- «Удалить полностью» (21.09.2026): a deletion that is not refused by the books.
--
-- Deleting a user has always been refused the moment the account carried a
-- payment, a promocode activation, a referral reward or points exchange, a
-- partner ledger entry — or a trial claim. The last one is what made a TEST
-- account undeletable for ever: take the free trial once and the row is
-- immortal, so the operator could never clear the accounts they create to
-- check their own product.
--
-- The refusal was right about one thing: a payment that happened happened, and
-- dropping it would silently rewrite the revenue already reported for a closed
-- month. So a full deletion does not drop those rows — it moves them onto a
-- new row that carries NO identity (no Telegram id, no e-mail, no login, no
-- name) and only what the books need: when the account was created and which
-- placement acquired it. The person is gone; the money is still counted.
--
-- This column is what tells such a holder apart from a customer. It is set
-- once and never cleared. Every customer-facing read excludes it:
-- `anonymizedUserFilter` in `users/utils` is the single reader, and
-- `test/anonymized-users-are-not-customers.spec.ts` holds the call sites.
--
-- Additive and replay-safe: one nullable column, no backfill, no lock beyond
-- the catalogue update, and nothing reads it until the panel ships with it
-- (`is_auto_recoverable_migration` in `docker-entrypoint.sh`).

SET lock_timeout = '5s';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "anonymized_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "users"."anonymized_at" IS
  'Not a person: a holder for the protected money history of a deleted account. Set once by a full deletion; every customer-facing read excludes these rows.';

-- The session outlives this file, so the bound comes off with the work it was
-- taken for; whatever migration runs next takes its own decision.
RESET lock_timeout;
