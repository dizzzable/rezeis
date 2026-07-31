-- Durable global-per-user trial quota ledger.
--
-- A paid trial reserves one unit in the same transaction that creates its
-- payment draft, before any provider/balance side effect. CONSUMED history is
-- never inferred from Subscription.is_trial at runtime because an upgrade
-- deliberately clears that presentation flag.
CREATE TYPE "TrialClaimStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');
CREATE TYPE "TrialClaimSource" AS ENUM ('FREE', 'PAID', 'LEGACY');

CREATE TABLE "trial_claims" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "plan_id" TEXT,
  "transaction_id" TEXT,
  "subscription_id" TEXT,
  "source" "TrialClaimSource" NOT NULL,
  "status" "TrialClaimStatus" NOT NULL,
  "units" INTEGER NOT NULL DEFAULT 1,
  "reserved_at" TIMESTAMPTZ(3),
  "consumed_at" TIMESTAMPTZ(3),
  "released_at" TIMESTAMPTZ(3),
  "release_reason" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trial_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trial_claims_units_positive" CHECK ("units" >= 1),
  CONSTRAINT "trial_claims_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "trial_claims_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "trial_claims_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "trial_claims_transaction_id_key" ON "trial_claims"("transaction_id");
CREATE UNIQUE INDEX "trial_claims_subscription_id_key" ON "trial_claims"("subscription_id");
CREATE INDEX "trial_claims_user_id_status_idx" ON "trial_claims"("user_id", "status");
CREATE INDEX "trial_claims_status_created_at_idx" ON "trial_claims"("status", "created_at");

-- 1. Exact evidence: every subscription that is still marked as a trial is
-- one consumed unit. The subscription FK is SET NULL so later deletion keeps
-- the immutable audit row.
INSERT INTO "trial_claims" (
  "id", "user_id", "plan_id", "subscription_id", "source", "status",
  "units", "consumed_at", "created_at", "updated_at"
)
SELECT
  'legacy_sub_' || md5(s."id"),
  s."user_id",
  NULLIF(s."plan_snapshot" ->> 'id', ''),
  s."id",
  'LEGACY'::"TrialClaimSource",
  'CONSUMED'::"TrialClaimStatus",
  1,
  COALESCE(s."started_at", s."created_at"),
  s."created_at",
  CURRENT_TIMESTAMP
FROM "subscriptions" s
WHERE s."is_trial" = TRUE
ON CONFLICT ("subscription_id") DO NOTHING;

-- 2. Historical TrialGrant markers survive upgrades, but the old model did
-- not store a count. Fail closed: add one synthetic aggregate row whose units
-- raise the user's consumed total to the marker plan's current, clamped
-- maxClaims (fallback 1 when the plan/settings are gone). This may deny an
-- unknowable unused legacy allowance, but it never re-opens a used trial.
WITH marker_limits AS (
  SELECT
    tg."id" AS grant_id,
    tg."user_id",
    tg."plan_id",
    tg."granted_at",
    CASE
      WHEN jsonb_typeof(p."trial_settings" -> 'maxClaims') = 'number'
        THEN FLOOR(
          LEAST(GREATEST((p."trial_settings" ->> 'maxClaims')::numeric, 1), 100)
        )::integer
      ELSE 1
    END AS max_claims
  FROM "trial_grants" tg
  LEFT JOIN "plans" p ON p."id" = tg."plan_id"
), consumed AS (
  SELECT "user_id", COALESCE(SUM("units"), 0)::integer AS units
  FROM "trial_claims"
  WHERE "status" = 'CONSUMED'
  GROUP BY "user_id"
)
INSERT INTO "trial_claims" (
  "id", "user_id", "plan_id", "source", "status", "units",
  "consumed_at", "created_at", "updated_at"
)
SELECT
  'legacy_grant_' || md5(m.grant_id),
  m."user_id",
  m."plan_id",
  'LEGACY'::"TrialClaimSource",
  'CONSUMED'::"TrialClaimStatus",
  m.max_claims - COALESCE(c.units, 0),
  m."granted_at",
  m."granted_at",
  CURRENT_TIMESTAMP
FROM marker_limits m
LEFT JOIN consumed c ON c."user_id" = m."user_id"
WHERE m.max_claims > COALESCE(c.units, 0)
ON CONFLICT ("id") DO NOTHING;

-- 3. Preserve paid trial attempts already in flight at deployment. These are
-- unresolved reservations, including locally timed-out rows that reconciliation
-- may revive on a late provider SUCCESS. We intentionally do not filter only
-- PENDING: local CANCELED/FAILED transactions remain revivable and ambiguous.
INSERT INTO "trial_claims" (
  "id", "user_id", "plan_id", "transaction_id", "source", "status",
  "units", "reserved_at", "created_at", "updated_at"
)
SELECT
  'legacy_tx_' || md5(t."id"),
  t."user_id",
  NULLIF(t."plan_snapshot" ->> 'id', ''),
  t."id",
  'PAID'::"TrialClaimSource",
  'RESERVED'::"TrialClaimStatus",
  1,
  t."created_at",
  t."created_at",
  CURRENT_TIMESTAMP
FROM "transactions" t
WHERE t."purchase_type" IN ('NEW', 'ADDITIONAL')
  AND t."fulfilled_at" IS NULL
  AND t."status" IN ('PENDING', 'CANCELED', 'FAILED')
  AND UPPER(COALESCE(t."plan_snapshot" ->> 'availability', '')) = 'TRIAL'
ON CONFLICT ("transaction_id") DO NOTHING;
