-- Two additions that together make blocking an account outlast the account.
--
-- ── 1. `DEVICE_HWID` joins the identity kinds ─────────────────────────────
--
-- WHY THIS REVERSES 20260828120000. That migration left device ids out on the
-- grounds that a shared household makes them "a signal, not a verdict". That
-- reasoning still holds for using a device id as a DOOR CHECK, and this
-- migration does not make it one: nobody has presented a hardware id at the
-- moment they register, so no sign-up path can consult this kind.
--
-- What changed is the question being asked. A ban is evaded with a new Telegram
-- account and a new mailbox, both free and both instant; the client software on
-- the machine is the one thing that carries over. Recording those ids when an
-- account is blocked is what makes "and they came straight back" answerable at
-- all. Enforcement happens after the fact, writes an audit row naming the
-- device that caused it, and is undone by deleting the entry — so a household
-- caught by it is visible and reversible, which is the property the original
-- objection was really about.
--
-- The value is lower-cased like the other text kinds. A hardware id is opaque,
-- and a client reporting it in a different case after a reinstall would
-- otherwise read as a different device; two genuinely distinct ids that differ
-- only in case do not occur, because these are uuids and hashes.
--
-- ── 2. `origin_user_id` records which ban created a cascade entry ─────────
--
-- Unblocking has to undo exactly what blocking created, and `source='cascade'`
-- alone cannot say WHOSE cascade a row came from. For a Telegram id or a login
-- that is recoverable — the value is on the account, so the unblock can look it
-- up — but a captured device id is NOT: reading the device list back requires
-- the VPN panel to be reachable at unblock time, and an unreachable panel would
-- silently leave the person banned by an entry their own ban created. That
-- failure is indistinguishable from "unblock does nothing", which is precisely
-- the class of defect this whole feature exists to remove.
--
-- Deliberately NOT a foreign key, matching `created_by_id` on the same table.
-- The entry has to survive deletion of the account it came from — that is the
-- point of an identity blocklist — and a real FK would either block the delete
-- or take the evidence with it.
--
-- ── Live safety ──────────────────────────────────────────────────────────
--
-- `ALTER TYPE ... ADD VALUE` takes no lock on any table. `ADD COLUMN` with no
-- default and no NOT NULL is a catalogue-only change in every PostgreSQL this
-- project supports — no table rewrite, no queue behind readers. `ADD VALUE` is
-- not transactional, which is why it is guarded rather than wrapped: re-running
-- this file after a partial application must not fail on a label that is
-- already there.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'BlockedIdentityKind' AND e.enumlabel = 'DEVICE_HWID'
  ) THEN
    ALTER TYPE "BlockedIdentityKind" ADD VALUE 'DEVICE_HWID';
  END IF;
END
$$;

ALTER TABLE "blocked_identities"
  ADD COLUMN IF NOT EXISTS "origin_user_id" TEXT;

CREATE INDEX IF NOT EXISTS "blocked_identities_origin_user_id_idx"
  ON "blocked_identities" ("origin_user_id");

SET lock_timeout = 0;

COMMENT ON COLUMN "blocked_identities"."origin_user_id" IS
  'The user whose block created this entry, for source=cascade rows. Not a foreign key: the entry must outlive the account it came from. NULL for entries an operator typed.';
