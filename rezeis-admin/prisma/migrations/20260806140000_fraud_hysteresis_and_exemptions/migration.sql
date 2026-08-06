-- Two gates in front of "a fraud signal opens", and the state each one needs.
--
-- WHY THIS RUNS ON LIVE DATA WITHOUT A REHEARSAL: migrations in this repo are
-- never executed in CI, so everything below is additive, idempotent and takes
-- no lock on an existing hot table. Both objects are brand new; nothing here
-- rewrites, backfills or reindexes a row that already exists, and `subscriptions`
-- — the largest table — is not referenced at all.
--
-- 1. fraud_candidate_streaks
--    Hysteresis. A detector run that names a condition for the first time is
--    not evidence, it is a reading; the signal only opens once the same
--    condition survives N consecutive OBSERVING runs (~15 minutes at the
--    5-minute cron). The counter cannot live in process memory: the API
--    container and the BullMQ worker each run their own AntiFraudService and
--    would hold half a streak each, and a deploy would reset both.
--
--    Identity is (code, condition_key), where condition_key is the detector
--    fingerprint with its UTC-day / ISO-week bucket and any `#<millis>`
--    re-file suffix stripped. Keying on the raw fingerprint would silently
--    reset every streak at midnight UTC. It is also exactly the key the
--    existing dismissal suppression uses, so the two gates cannot disagree
--    about what "the same condition" is.
--
--    held_by carries WHY the last run declined to open the row — 'streak'
--    (still gathering evidence) or 'exemption' (an operator exemption covers
--    it). That column is the whole answer to "a suppression that leaves no
--    trace is how detectors quietly stop detecting": every held candidate is
--    listed by GET /admin/fraud/pending.
--
-- 2. fraud_exemptions
--    A whitelist with a MANDATORY expiry and per-detector-code scope.
--    expires_at is NOT NULL because a permanent exemption is a permanent blind
--    spot nobody ever revisits — the column type is what enforces that, and
--    unlike a service-side check it cannot be loosened by accident. `codes` is
--    an array rather than a boolean because a user whose device count is
--    legitimately high has not thereby been cleared of promocode abuse.
--
--    Revocation sets revoked_at/revoked_by instead of deleting: granting an
--    exemption is an audit-relevant act and so is taking one away. created_by
--    and revoked_by are ON DELETE SET NULL so removing an admin account cannot
--    delete the record of what they exempted.

-- 1. The hysteresis ledger. No foreign keys on purpose: this table is rewritten
-- every five minutes and must not take a reference lock on users or on
-- fraud_exemptions to do it. exemption_id is therefore a plain id — a dangling
-- value degrades to "held by an exemption we can no longer name", which is
-- still visible, and never blocks a write.
CREATE TABLE IF NOT EXISTS "fraud_candidate_streaks" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "condition_key" TEXT NOT NULL,
  "observations" INTEGER NOT NULL DEFAULT 1,
  "severity" "FraudSignalSeverity" NOT NULL,
  "last_severity" "FraudSignalSeverity" NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "title" TEXT NOT NULL,
  "affected_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "held_by" TEXT NOT NULL DEFAULT 'streak',
  "exemption_id" TEXT,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NO database default, deliberately: the schema declares this column
  -- `@updatedAt` and nothing else, so Prisma Client supplies the value on
  -- every insert and update. Giving it a DEFAULT here would make
  -- `prisma migrate diff` demand a DROP DEFAULT and the next `migrate dev`
  -- emit an unwanted migration to remove it. `@updatedAt` + bare NOT NULL is
  -- how every other table in this schema writes the column.
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "fraud_candidate_streaks_pkey" PRIMARY KEY ("id")
);

-- Stated as a separate ALTER rather than inline in the CREATE so that a table
-- left behind by a half-applied earlier run still gets the constraint —
-- CREATE TABLE IF NOT EXISTS skips the whole statement, constraints included.
ALTER TABLE "fraud_candidate_streaks"
  DROP CONSTRAINT IF EXISTS "fraud_candidate_streaks_observations_positive";
ALTER TABLE "fraud_candidate_streaks"
  ADD CONSTRAINT "fraud_candidate_streaks_observations_positive" CHECK ("observations" >= 1);

-- The upsert key every detector run writes through.
CREATE UNIQUE INDEX IF NOT EXISTS "fraud_candidate_streaks_code_condition_key_key"
  ON "fraud_candidate_streaks"("code", "condition_key");

-- Ageing out streaks whose detector went quiet, and the pending list's sort.
CREATE INDEX IF NOT EXISTS "fraud_candidate_streaks_last_seen_at_idx"
  ON "fraud_candidate_streaks"("last_seen_at");

-- "Show me everything an exemption is currently swallowing."
CREATE INDEX IF NOT EXISTS "fraud_candidate_streaks_held_by_idx"
  ON "fraud_candidate_streaks"("held_by");

-- 2. The whitelist.
CREATE TABLE IF NOT EXISTS "fraud_exemptions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reason" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_by" TEXT,
  "revoked_at" TIMESTAMPTZ(3),
  "revoked_by" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- No database default — see `fraud_candidate_streaks.updated_at` above.
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "fraud_exemptions_pkey" PRIMARY KEY ("id")
);

-- A blanket exemption is not expressible. Enforced here as well as in the DTO
-- so a caller that bypasses HTTP cannot write one either.
--
-- `cardinality`, NOT `array_length`. `array_length(ARRAY[]::text[], 1)` is NULL
-- rather than 0, and a CHECK that evaluates to NULL PASSES — the first draft of
-- this migration accepted an empty `codes` array against a real Postgres 17 for
-- exactly that reason. `cardinality` returns 0 and the constraint bites.
ALTER TABLE "fraud_exemptions"
  DROP CONSTRAINT IF EXISTS "fraud_exemptions_codes_not_empty";
ALTER TABLE "fraud_exemptions"
  ADD CONSTRAINT "fraud_exemptions_codes_not_empty" CHECK (cardinality("codes") >= 1);

-- Deleting the user deletes the exemption: an exemption for a user who no
-- longer exists can only ever be a stale rule that nothing will re-check.
ALTER TABLE "fraud_exemptions"
  DROP CONSTRAINT IF EXISTS "fraud_exemptions_user_id_fkey";
ALTER TABLE "fraud_exemptions"
  ADD CONSTRAINT "fraud_exemptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The admin, in contrast, is SET NULL: who granted it is history, and history
-- must survive the person leaving.
ALTER TABLE "fraud_exemptions"
  DROP CONSTRAINT IF EXISTS "fraud_exemptions_created_by_fkey";
ALTER TABLE "fraud_exemptions"
  ADD CONSTRAINT "fraud_exemptions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "fraud_exemptions"
  DROP CONSTRAINT IF EXISTS "fraud_exemptions_revoked_by_fkey";
ALTER TABLE "fraud_exemptions"
  ADD CONSTRAINT "fraud_exemptions_revoked_by_fkey"
  FOREIGN KEY ("revoked_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The lookup every detector run does: live exemptions for the candidate's users.
CREATE INDEX IF NOT EXISTS "fraud_exemptions_user_id_idx"
  ON "fraud_exemptions"("user_id");

-- "Which exemptions are about to lapse" — and the run's own expiry filter.
CREATE INDEX IF NOT EXISTS "fraud_exemptions_expires_at_idx"
  ON "fraud_exemptions"("expires_at");
