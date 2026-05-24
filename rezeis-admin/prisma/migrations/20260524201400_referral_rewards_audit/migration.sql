-- Phase v0.2.14 — referral rewards audit trail.
--
-- Track *which admin* issued a reward and *who initiated* a manual grant,
-- so the SPA can render an "issued by" column and ops can investigate
-- support cases retroactively. Both columns are nullable: legacy rows
-- have `null` because we never recorded the actor before this migration,
-- and auto-issued rewards (cron path) keep `null` to distinguish from
-- manual operator actions.

ALTER TABLE "referral_rewards"
  ADD COLUMN IF NOT EXISTS "issued_by" TEXT,
  ADD COLUMN IF NOT EXISTS "granted_by" TEXT,
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "revoke_reason" TEXT;

CREATE INDEX IF NOT EXISTS "referral_rewards_issued_by_idx"
  ON "referral_rewards" ("issued_by");

CREATE INDEX IF NOT EXISTS "referral_rewards_granted_by_idx"
  ON "referral_rewards" ("granted_by");

CREATE INDEX IF NOT EXISTS "referral_rewards_revoked_at_idx"
  ON "referral_rewards" ("revoked_at");
