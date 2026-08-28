-- Identity-based access blocklist.
--
-- WHAT IT FIXES. `users.is_blocked` is a flag on a row, so it can only refuse
-- somebody who has already registered, and it is undone by registering again
-- with a fresh Telegram account. An operator also had no way to refuse a person
-- BEFORE their first `/start` — the list of ids to keep out simply had nowhere
-- to live. This table is keyed on the identity rather than on the account, so a
-- ban can precede the account and survive it.
--
-- WHY THESE THREE KINDS. Telegram id, e-mail and web login are identifiers a
-- person chooses and reuses. IP addresses are deliberately absent — they move,
-- and `blocked_ips` already owns that axis. Device ids are absent for the
-- opposite reason: shared households and reinstalled clients make them a signal
-- worth surfacing, not a verdict worth enforcing.
--
-- WHY `value` IS TEXT, INCLUDING FOR TELEGRAM IDS. The entry has to exist
-- before any `users` row does, so it cannot be a foreign key, and a bigint
-- column would force the same normalisation question in two types. One text
-- column with a documented normalisation (digits only / lower-cased) keeps the
-- unique index meaning "this person" rather than "this spelling".
--
-- NO BACKFILL. Existing `users.is_blocked` rows are NOT copied in. The flag
-- keeps working exactly as it does today and this table is additive: on the day
-- it ships, nothing behaves differently until an operator adds an entry. A
-- backfill would also be a guess — a blocked account tells us the account was
-- refused, not that every identity on it should be refused forever.
--
-- LIVE SAFETY. `CREATE TABLE` / `CREATE TYPE` take no lock on existing tables:
-- nothing here queues behind readers of `users` or `subscriptions`. The
-- `lock_timeout` is kept anyway for the same reason 20260823120000 keeps it —
-- so a surprise never turns into a pool-exhausting stall — and every statement
-- is replay-safe, so this file can be re-applied in full after a partial run.
SET lock_timeout = '5s';

-- `CREATE TYPE` has no `IF NOT EXISTS` in PostgreSQL, hence the guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BlockedIdentityKind') THEN
    CREATE TYPE "BlockedIdentityKind" AS ENUM ('TELEGRAM_ID', 'EMAIL', 'WEB_LOGIN');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "blocked_identities" (
  "id"            TEXT NOT NULL,
  "kind"          "BlockedIdentityKind" NOT NULL,
  "value"         TEXT NOT NULL,
  "reason"        TEXT,
  "source"        TEXT NOT NULL DEFAULT 'manual',
  "created_by_id" TEXT,
  "expires_at"    TIMESTAMPTZ(3),
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "blocked_identities_pkey" PRIMARY KEY ("id")
);

-- The lookup every registration path performs, and the guarantee that one
-- identity cannot be listed twice with two different reasons.
CREATE UNIQUE INDEX IF NOT EXISTS "blocked_identities_kind_value_key"
  ON "blocked_identities" ("kind", "value");
CREATE INDEX IF NOT EXISTS "blocked_identities_source_idx"
  ON "blocked_identities" ("source");
CREATE INDEX IF NOT EXISTS "blocked_identities_expires_at_idx"
  ON "blocked_identities" ("expires_at");
CREATE INDEX IF NOT EXISTS "blocked_identities_created_at_idx"
  ON "blocked_identities" ("created_at");

-- Back to the server default; Prisma opens no transaction per migration, so a
-- plain `SET` would outlive this file on the same connection.
SET lock_timeout = 0;

COMMENT ON TABLE "blocked_identities" IS
  'Identity-based access blocklist. Unlike users.is_blocked it is keyed on the identity, so an entry can precede the account and survive it.';
COMMENT ON COLUMN "blocked_identities"."value" IS
  'Normalised: digits only for TELEGRAM_ID, trimmed and lower-cased for EMAIL and WEB_LOGIN. Normalising on write is what makes the unique index mean "this person".';
COMMENT ON COLUMN "blocked_identities"."source" IS
  'manual (human), automation (rule-emitted), cascade (captured when an existing user was blocked).';
COMMENT ON COLUMN "blocked_identities"."expires_at" IS
  'NULL means permanent. Readers must treat an expired row as absent rather than deleting it, so the history of a temporary ban survives it.';
