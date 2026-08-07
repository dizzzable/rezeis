-- Documents an operator can require at sign-up, and the record of who accepted
-- what.
--
-- WHY THIS RUNS ON LIVE DATA WITHOUT A REHEARSAL: migrations in this repo are
-- never executed in CI, so everything below is additive, idempotent and takes
-- no lock on an existing hot table. Both tables and the enum are brand new.
-- The only reference to an existing table is the FK from user_legal_consents
-- to users(id) — adding a foreign key on a NEW, EMPTY child table validates
-- against nothing and does not rewrite `users`.
--
-- 1. legal_documents
--    Exactly two rows, seeded below, keyed by the enum rather than a slug.
--    There is no create and no delete anywhere in the application: an operator
--    edits text and flips `is_active`. Making the key the primary key is what
--    enforces that at the storage level — a third document requires a
--    migration, which is the point. The registration gate names these keys in
--    a contract shared with reiwa, and a free-form slug would turn that
--    contract into "whatever rows happen to exist".
--
--    Bodies are plain text. There is no sanitizer in the admin panel, and
--    reiwa keeps DOMPurify out of the pre-login bundle on purpose — which is
--    the bundle the registration screen ships in. Storing markup would mean
--    either rendering it unsanitised on the one screen that must not be
--    compromised, or pulling a sanitizer into it.
--
--    Seeded INACTIVE. A migration that switched a consent gate on would, on
--    every existing install, start refusing registrations the moment it ran —
--    the documents are empty at that instant, so every sign-up would be
--    blocked on text nobody has written yet. The operator turns each one on
--    after filling it in.
--
-- 2. user_legal_consents
--    One row per (user, document), written inside the same transaction that
--    creates the account. Absence of a row means "never accepted".
--
--    This deliberately does NOT reuse users.is_rules_accepted, which defaults
--    to TRUE and therefore declares every existing and every future user to
--    have accepted. That column keeps serving the older bot-side rules gate;
--    it is not touched here.
--
--    ON DELETE CASCADE on both sides: a consent is meaningless without its
--    user, and the account-deletion path must not be blocked by it. This is
--    the opposite choice from trial_claims (RESTRICT), and for the opposite
--    reason — a trial claim is a quota ledger that has to survive deletion, a
--    consent is not.

-- ── enum ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LegalDocumentKey') THEN
    CREATE TYPE "LegalDocumentKey" AS ENUM ('USER_AGREEMENT', 'OFFER');
  END IF;
END
$$;

-- ── documents ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "legal_documents" (
  "key"        "LegalDocumentKey" NOT NULL,
  "is_active"  BOOLEAN            NOT NULL DEFAULT false,
  "title_ru"   TEXT               NOT NULL DEFAULT '',
  "title_en"   TEXT               NOT NULL DEFAULT '',
  "body_ru"    TEXT               NOT NULL DEFAULT '',
  "body_en"    TEXT               NOT NULL DEFAULT '',
  -- No DEFAULT: `schema.prisma` declares this column as `@updatedAt` with no
  -- `@default`, and Prisma writes the value on every update itself. A default
  -- here would exist in the database and not in the schema, which is exactly
  -- the drift 20260806170000 had to reverse on three other tables. The service
  -- always supplies the column, so NOT NULL is satisfied without one.
  "updated_at" TIMESTAMPTZ(3)     NOT NULL,

  CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("key")
);

-- Both rows always exist so every read is a plain lookup and the admin surface
-- never has to distinguish "not configured yet" from "row missing".
INSERT INTO "legal_documents" ("key", "updated_at")
VALUES ('USER_AGREEMENT', CURRENT_TIMESTAMP), ('OFFER', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- ── consents ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_legal_consents" (
  "user_id"      TEXT               NOT NULL,
  "document_key" "LegalDocumentKey" NOT NULL,
  "accepted_at"  TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_legal_consents_pkey" PRIMARY KEY ("user_id", "document_key")
);

CREATE INDEX IF NOT EXISTS "user_legal_consents_document_key_idx"
  ON "user_legal_consents" ("document_key");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_legal_consents_user_id_fkey'
  ) THEN
    ALTER TABLE "user_legal_consents"
      ADD CONSTRAINT "user_legal_consents_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_legal_consents_document_key_fkey'
  ) THEN
    ALTER TABLE "user_legal_consents"
      ADD CONSTRAINT "user_legal_consents_document_key_fkey"
      FOREIGN KEY ("document_key") REFERENCES "legal_documents" ("key")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
