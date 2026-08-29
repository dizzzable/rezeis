-- Operator-authored hints, and the queue that owes them to people.
--
-- ── What this is for ──────────────────────────────────────────────────────
--
-- Leading a customer by the hand to the place they need next: after a payment
-- clears, show where the connection instructions live; after a device is
-- unbound, show where to bind a new one. The cabinet already ships a spotlight
-- tour (`features/onboarding`), but its five steps are a constant in the source
-- and it starts on exactly one condition — first dashboard mount. Nothing an
-- operator can author, and nothing any event can trigger.
--
-- ── Why a queue and not a push ────────────────────────────────────────────
--
-- Because the moment a hint is EARNED and the moment it can be SHOWN are not
-- the same moment, and nothing makes them line up:
--
--   • a card payment's webhook usually lands before the browser has finished
--     redirecting back, so the hint is earned while no page is mounted;
--   • a crypto payment can confirm twenty minutes later, long after the buyer
--     closed the tab;
--   • an operator unbinding a device at 03:00 has no audience at all.
--
-- So the raising side writes a row here and the cabinet drains it on the
-- customer's next visit. Delivering at raise time would mean delivering to
-- nobody, which is the failure this table exists to avoid.
--
-- ── Why the copy is NOT stored on the delivery ────────────────────────────
--
-- A delivery points at `user_hints` and the text is read when it is shown, the
-- same way a notification template is read when the message is sent. An
-- operator fixing a typo fixes it for everyone still holding the hint unseen.
-- The cost — a hint can change between being queued and being read — is the
-- better half of the trade; the alternative freezes every typo into every
-- pending row.
--
-- It also settles what disabling means without a second rule: `is_active =
-- false` stops the hint being shown, queued rows stay and lapse on their own
-- clock, and switching it back on resumes whatever has not expired.
--
-- ── Why `expires_at` is computed at insert and not read live ──────────────
--
-- The hint carries `ttl_hours`, but the DELIVERY carries the resolved instant.
-- Reading the TTL at show time would let an operator lengthening it resurrect
-- rows that had already lapsed — a customer meeting a hint about a payment that
-- failed three weeks ago.
--
-- ── Why `acted_at` is separate from `dismissed_at` ────────────────────────
--
-- Collapsing them makes "this hint helps" indistinguishable from "people close
-- it to make it go away", and that is the only question worth asking of a hint.
-- A modal whose sole exit is its own call to action would score a perfect
-- record while being pure annoyance.
--
-- ── Live safety ──────────────────────────────────────────────────────────
--
-- CREATE TYPE and CREATE TABLE take no lock on existing tables. The only touch
-- to a live table is the FK from `user_hint_deliveries` to `users`, which takes
-- a SHARE ROW EXCLUSIVE on `users` for the validation scan — bounded by
-- `lock_timeout` rather than allowed to queue behind a long transaction. Every
-- statement is guarded so the file survives being re-applied after a partial
-- run.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserHintMode') THEN
    CREATE TYPE "UserHintMode" AS ENUM ('MODAL', 'DRAWER', 'TOAST', 'INLINE', 'SPOTLIGHT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserHintTone') THEN
    CREATE TYPE "UserHintTone" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'DANGER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserHintCtaKind') THEN
    CREATE TYPE "UserHintCtaKind" AS ENUM ('NONE', 'ROUTE', 'EXTERNAL');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "user_hints" (
  "id"            TEXT              NOT NULL,
  "key"           TEXT              NOT NULL,
  "title_ru"      TEXT              NOT NULL,
  "body_ru"       TEXT              NOT NULL,
  "title_en"      TEXT,
  "body_en"       TEXT,
  "mode"          "UserHintMode"    NOT NULL DEFAULT 'MODAL',
  "tone"          "UserHintTone"    NOT NULL DEFAULT 'INFO',
  "cta_kind"      "UserHintCtaKind" NOT NULL DEFAULT 'NONE',
  "cta_label_ru"  TEXT,
  "cta_label_en"  TEXT,
  "cta_target"    TEXT,
  -- Empty means "every surface", which is the common case. Non-empty is for the
  -- handful of hints that are actively WRONG somewhere: "install the app" to
  -- somebody running the installed app, "open our bot" to somebody already
  -- inside Telegram.
  "surfaces"      TEXT[]            NOT NULL DEFAULT ARRAY[]::TEXT[],
  "form_factors"  TEXT[]            NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Hints sharing a group supersede one another. One purchase emits four
  -- events (payment.completed, subscription.created, referral.qualified,
  -- promocode.activated); without this the customer meets four modals.
  "group_key"     TEXT,
  "ttl_hours"     INTEGER           NOT NULL DEFAULT 168,
  "is_repeatable" BOOLEAN           NOT NULL DEFAULT false,
  "is_active"     BOOLEAN           NOT NULL DEFAULT true,
  "created_at"    TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(3)    NOT NULL,
  CONSTRAINT "user_hints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_hints_key_key" ON "user_hints" ("key");
CREATE INDEX IF NOT EXISTS "user_hints_is_active_idx" ON "user_hints" ("is_active");
CREATE INDEX IF NOT EXISTS "user_hints_group_key_idx" ON "user_hints" ("group_key");

CREATE TABLE IF NOT EXISTS "user_hint_deliveries" (
  "id"           TEXT           NOT NULL,
  "user_id"      TEXT           NOT NULL,
  "hint_id"      TEXT           NOT NULL,
  -- `moment:<name>` for something the cabinet detected itself, `rule:<id>` for
  -- an automation. Free text because the two namespaces share nothing, and it
  -- is read by operators rather than matched by code.
  "source"       TEXT           NOT NULL,
  "expires_at"   TIMESTAMPTZ(3) NOT NULL,
  "shown_at"     TIMESTAMPTZ(3),
  "dismissed_at" TIMESTAMPTZ(3),
  "acted_at"     TIMESTAMPTZ(3),
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_hint_deliveries_pkey" PRIMARY KEY ("id")
);

-- The one query the cabinet runs on every visit: what does this person still
-- owe-and-not-yet-seen that has not lapsed.
CREATE INDEX IF NOT EXISTS "user_hint_deliveries_user_id_shown_at_expires_at_idx"
  ON "user_hint_deliveries" ("user_id", "shown_at", "expires_at");
CREATE INDEX IF NOT EXISTS "user_hint_deliveries_hint_id_idx"
  ON "user_hint_deliveries" ("hint_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_hint_deliveries_user_id_fkey'
  ) THEN
    ALTER TABLE "user_hint_deliveries"
      ADD CONSTRAINT "user_hint_deliveries_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_hint_deliveries_hint_id_fkey'
  ) THEN
    ALTER TABLE "user_hint_deliveries"
      ADD CONSTRAINT "user_hint_deliveries_hint_id_fkey"
      FOREIGN KEY ("hint_id") REFERENCES "user_hints" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

COMMENT ON TABLE "user_hints" IS
  'Operator-authored in-cabinet hints. The library; deliveries live next door.';
COMMENT ON TABLE "user_hint_deliveries" IS
  'One hint owed to one person, raised when it was earned and shown on their next visit.';
COMMENT ON COLUMN "user_hint_deliveries"."expires_at" IS
  'Resolved at insert from the hint TTL, never re-read: lengthening a TTL must not resurrect lapsed rows.';
COMMENT ON COLUMN "user_hint_deliveries"."acted_at" IS
  'Button followed, as opposed to dismissed — the difference between a hint that helps and one people close to be rid of.';

RESET lock_timeout;
