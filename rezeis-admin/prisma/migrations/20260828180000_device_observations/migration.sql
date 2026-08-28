-- Device signals from the cabinet, and the quiet flag they raise.
--
-- ── What this is for ──────────────────────────────────────────────────────
--
-- A ban is evaded with a new Telegram account and a new mailbox. Both are free
-- and instant, so neither is a real cost, and `blocked_identities` can only
-- refuse the identities a person retypes. The machine is the one thing that
-- carries over — and for the cabinet, which can be used without ever touching
-- Telegram, it is the ONLY thing that carries over.
--
-- ── What the browser can and cannot see, since this is where it gets sold ──
--
-- A web page cannot read a MAC address, a disk serial or a motherboard id.
-- There is no API, and a MAC never leaves the local link in the first place.
-- Anything advertised as a "hardware ban" on the web is a fingerprint wearing
-- a better name. Real hardware bans — Vanguard and its relatives — need a
-- kernel driver on the customer's machine, which is not a thing a VPN service
-- gets to install.
--
-- So what is stored here is derived, and its strength is stated honestly in the
-- two kinds:
--
--   INSTALL_ID   a random value the cabinet persists. Exact, and gone the
--                moment somebody clears site data.
--   DEVICE_HASH  a digest over what the GRAPHICS STACK does — canvas, WebGL
--                renderer, audio. A function of the GPU, driver and OS rather
--                than of the browser, which is why it survives a cleared
--                profile and usually a different browser on the same machine.
--                It is NOT unique to a person: identical corporate laptops
--                produce identical values.
--
-- ── Why a flag and not a refusal ─────────────────────────────────────────
--
-- Because of that last sentence. A device match says the same MACHINE is
-- involved, never the same person. Households share computers and offices
-- deploy identical images, so refusing on this evidence would turn every one of
-- them into a customer who cannot register and is not told why. The account is
-- created normally and `user_review_flags` asks an operator to look.
--
-- The flag is invisible to the account it sits on, and the endpoint that raises
-- one answers identically whether or not it did. A visible flag teaches an
-- evader which signal gave them away.
--
-- ── No raw components are stored ─────────────────────────────────────────
--
-- Only the two derived values. The font list, the screen geometry and the GPU
-- string that went into the hash are used to compute it and discarded, so this
-- table cannot be read back into a profile of anybody's machine.
--
-- ── Live safety ──────────────────────────────────────────────────────────
--
-- CREATE TABLE and CREATE TYPE take no lock on existing tables. ALTER TYPE ...
-- ADD VALUE is not transactional, hence the guard rather than a wrapper: this
-- file must survive being re-applied after a partial run.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'BlockedIdentityKind' AND e.enumlabel = 'DEVICE_FP'
  ) THEN
    ALTER TYPE "BlockedIdentityKind" ADD VALUE 'DEVICE_FP';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeviceSignalKind') THEN
    CREATE TYPE "DeviceSignalKind" AS ENUM ('INSTALL_ID', 'DEVICE_HASH');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserReviewFlagKind') THEN
    CREATE TYPE "UserReviewFlagKind" AS ENUM ('DEVICE_MATCH');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "device_observations" (
  "id"            TEXT NOT NULL,
  "user_id"       TEXT NOT NULL,
  "kind"          "DeviceSignalKind" NOT NULL,
  "value"         TEXT NOT NULL,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hits"          INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "device_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "device_observations_user_id_kind_value_key"
  ON "device_observations" ("user_id", "kind", "value");
-- The lookup the whole feature turns on: who ELSE reported this signal.
CREATE INDEX IF NOT EXISTS "device_observations_kind_value_idx"
  ON "device_observations" ("kind", "value");
CREATE INDEX IF NOT EXISTS "device_observations_user_id_idx"
  ON "device_observations" ("user_id");

CREATE TABLE IF NOT EXISTS "user_review_flags" (
  "id"              TEXT NOT NULL,
  "user_id"         TEXT NOT NULL,
  "kind"            "UserReviewFlagKind" NOT NULL,
  "fingerprint"     TEXT NOT NULL,
  "related_user_id" TEXT,
  "detail"          JSONB NOT NULL DEFAULT '{}',
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL,
  "cleared_at"      TIMESTAMPTZ(3),
  "cleared_by_id"   TEXT,

  CONSTRAINT "user_review_flags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_review_flags_user_id_kind_fingerprint_key"
  ON "user_review_flags" ("user_id", "kind", "fingerprint");
-- The badge query on the users list: open flags for one page of user ids.
CREATE INDEX IF NOT EXISTS "user_review_flags_user_id_cleared_at_idx"
  ON "user_review_flags" ("user_id", "cleared_at");
CREATE INDEX IF NOT EXISTS "user_review_flags_cleared_at_idx"
  ON "user_review_flags" ("cleared_at");

-- Both cascade with the user. The observation is working data and the flag
-- belongs to the account it marks; the durable half of a ban lives on
-- `blocked_identities`, which is deliberately NOT a foreign key to anything.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_observations_user_id_fkey'
  ) THEN
    ALTER TABLE "device_observations"
      ADD CONSTRAINT "device_observations_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_review_flags_user_id_fkey'
  ) THEN
    ALTER TABLE "user_review_flags"
      ADD CONSTRAINT "user_review_flags_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

SET lock_timeout = 0;

COMMENT ON TABLE "device_observations" IS
  'Derived device signals reported by the cabinet. Observations, not a device registry: one person has several, and one signal can belong to several people.';
COMMENT ON COLUMN "device_observations"."value" IS
  'Opaque derived value. No raw fingerprint components are stored — they are hashed and discarded.';
COMMENT ON TABLE "user_review_flags" IS
  'Quiet operator-facing mark on an account. Never visible to the account it sits on, and never a refusal: a device match proves the same machine, not the same person.';
