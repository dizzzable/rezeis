-- A promocode becomes CONDITIONS -> ACTIONS instead of conditions -> one reward.
--
-- WHAT WAS WRONG. A code could do exactly one thing. "-10% on the next purchase
-- AND +7 days" therefore needed two codes and a line of copy telling the
-- customer to enter both, and every new marketing shape meant either a new
-- reward type in the code base or a workaround in the wording. The operator
-- could not compose an offer; only a developer could.
--
-- WHAT DOES NOT CHANGE. `promocodes.reward_type` / `reward` / `plan` and
-- `promocode_activations.reward_type` / `reward_value` stay, and stay filled
-- from the FIRST action. The panel and the cabinet ship as separate images, so
-- the older half has to keep reading these rows; and partner reports, CSV
-- export, code statistics and quick search all read them today.
--
-- THE ONE AMBIGUITY THIS RESOLVES. `promocodes.allowed_plan_ids` means two
-- different things depending on the reward type, which is exactly why the
-- reward and the conditions had to be separated:
--
--   * SUBSCRIPTION -- never a filter. The plan to GRANT lives in `plan`, and
--     `allowed_plan_ids` was carried along by the form.
--   * everything else -- it IS a filter: which existing subscription the code
--     may be activated against.
--
-- So the backfill below moves ONLY the SUBSCRIPTION plan onto the action, and
-- leaves `allowed_plan_ids` a condition for every type including
-- PURCHASE_DISCOUNT. Copying it onto a discount would read as preserving the
-- operator's intent and do the opposite: it would turn "for customers on
-- plan-a" into "spendable only on plan-a", while the condition kept applying
-- too. Restricting where a discount is SPENT is a new thing an operator sets
-- deliberately, not something to infer from a column that never meant it.

SET lock_timeout = '5s';

-- == ACTIONS =================================================================

CREATE TABLE IF NOT EXISTS "promocode_actions" (
  "id"           TEXT NOT NULL,
  "promocode_id" TEXT NOT NULL,
  "type"         "PromocodeRewardType" NOT NULL,
  "value"        INTEGER,
  "payload"      JSONB,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promocode_actions_pkey" PRIMARY KEY ("id")
);

-- One index, not two: the unique below leads with `promocode_id`, which is the
-- only way this table is ever read (`include: { actions: true }`). A separate
-- single-column index on the same leading column is write cost for nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "promocode_actions_promocode_id_type_key"
  ON "promocode_actions" ("promocode_id", "type");

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'promocode_actions_promocode_id_fkey'
  ) THEN
    ALTER TABLE "promocode_actions"
      ADD CONSTRAINT "promocode_actions_promocode_id_fkey"
      FOREIGN KEY ("promocode_id") REFERENCES "promocodes"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

COMMENT ON TABLE "promocode_actions" IS
  'What a promocode does, as a list. Order is derived from the type, not stored: SUBSCRIPTION runs first because it replaces the subscription the other actions would otherwise mutate.';
COMMENT ON COLUMN "promocode_actions"."payload" IS
  'SUBSCRIPTION: the plan snapshot to grant. PURCHASE_DISCOUNT: { allowedPlanIds, validForDays } - restrictions the granted discount carries to the checkout it is finally spent at.';

-- == EFFECTS =================================================================

CREATE TABLE IF NOT EXISTS "promocode_activation_effects" (
  "id"            TEXT NOT NULL,
  "activation_id" TEXT NOT NULL,
  "type"          "PromocodeRewardType" NOT NULL,
  "applied_value" INTEGER NOT NULL DEFAULT 0,
  "payload"       JSONB,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promocode_activation_effects_pkey" PRIMARY KEY ("id")
);

-- Only by activation. Nothing filters effects by type — the reports that group
-- by reward type read `promocode_activations.reward_type`, which is still
-- written — and this table takes a row per action per activation, so an index
-- nobody queries is pure insert cost.
CREATE INDEX IF NOT EXISTS "promocode_activation_effects_activation_id_idx"
  ON "promocode_activation_effects" ("activation_id");

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'promocode_activation_effects_activation_id_fkey'
  ) THEN
    ALTER TABLE "promocode_activation_effects"
      ADD CONSTRAINT "promocode_activation_effects_activation_id_fkey"
      FOREIGN KEY ("activation_id") REFERENCES "promocode_activations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

COMMENT ON COLUMN "promocode_activation_effects"."applied_value" IS
  'What really happened, which already differs from the configured value today: a SUBSCRIPTION action takes its duration from the plan snapshot, not from the configured number.';

-- == DEFERRED DISCOUNTS ======================================================

CREATE TABLE IF NOT EXISTS "user_pending_discounts" (
  "id"                  TEXT NOT NULL,
  "user_id"             TEXT NOT NULL,
  "percent"             INTEGER NOT NULL,
  "allowed_plan_ids"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expires_at"          TIMESTAMPTZ(3),
  "source_promocode_id" TEXT,
  "consumed_at"         TIMESTAMPTZ(3),
  "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_pending_discounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "user_pending_discounts_user_id_consumed_at_idx"
  ON "user_pending_discounts" ("user_id", "consumed_at");

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_pending_discounts_user_id_fkey'
  ) THEN
    ALTER TABLE "user_pending_discounts"
      ADD CONSTRAINT "user_pending_discounts_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

COMMENT ON TABLE "user_pending_discounts" IS
  'A granted, unspent discount together with the restrictions it must survive until it is spent. users.purchase_discount is a bare percentage whose promocode restrictions were checked at activation and forgotten by checkout, so "-20% but only on the six-month plan" could not be expressed at all.';

-- == BACKFILL: every existing promocode gets exactly one action ==============
--
-- Idempotent through the unique (promocode_id, type): a replay inserts nothing.
-- The deterministic id means a replay cannot produce a second row under a
-- different key either.

INSERT INTO "promocode_actions" ("id", "promocode_id", "type", "value", "payload", "created_at")
SELECT
  md5('promocode-action:' || p."id"),
  p."id",
  p."reward_type",
  p."reward",
  CASE
    -- SUBSCRIPTION carried the plan to GRANT, never a filter.
    WHEN p."reward_type" = 'SUBSCRIPTION' AND p."plan" IS NOT NULL
      THEN jsonb_build_object('plan', p."plan")
    -- EVERY OTHER TYPE, INCLUDING PURCHASE_DISCOUNT, keeps `allowed_plan_ids`
    -- as a CONDITION and gets no payload.
    --
    -- Copying it onto a discount action looked like preserving the operator's
    -- intent and was the opposite: as a condition it filters the user's
    -- EXISTING subscription at activation, and in the payload it would filter
    -- the plan BEING BOUGHT at checkout. "-20% off your next purchase, for
    -- customers on plan-a" would silently become "-20% spendable only on
    -- plan-a" — and since the column stays, the activation filter still
    -- applies too, so the restriction would bind twice under two meanings.
    --
    -- A code that should restrict where the discount is SPENT is a new thing
    -- an operator sets deliberately; it is not something to infer from a
    -- column that never meant that.
    ELSE NULL
  END,
  p."created_at"
FROM "promocodes" p
-- UNTARGETED, deliberately. The id is deterministic on the PROMOCODE, while
-- `(promocode_id, type)` is a different key: if the mirrored `reward_type` has
-- moved away from the type the action row carries — which a legacy
-- `PATCH { rewardType }` used to do — a replay conflicts on the PRIMARY KEY
-- and not on the arbiter. Targeted, that aborts the migration; the entrypoint
-- then marks it rolled back, retries it once, fails identically and exits, so
-- the API never comes up. An untargeted clause covers every unique violation
-- this insert can raise.
ON CONFLICT DO NOTHING;

-- == BACKFILL: every past activation gets exactly one effect =================

INSERT INTO "promocode_activation_effects" ("id", "activation_id", "type", "applied_value", "created_at")
SELECT
  md5('promocode-effect:' || a."id"),
  a."id",
  a."reward_type",
  a."reward_value",
  a."activated_at"
FROM "promocode_activations" a
WHERE NOT EXISTS (
  SELECT 1 FROM "promocode_activation_effects" e WHERE e."activation_id" = a."id"
);

-- == BACKFILL: discounts people are already holding ==========================
--
-- users.purchase_discount is a one-time grant that has not been spent. It keeps
-- working on its own - the checkout still reads the column - so this row is
-- written for VISIBILITY, not to move the mechanism: the operator can now see
-- who holds what. No plan restriction and no expiry, because the old column
-- never carried either.

INSERT INTO "user_pending_discounts" ("id", "user_id", "percent", "created_at")
SELECT
  md5('pending-discount:' || u."id"),
  u."id",
  LEAST(u."purchase_discount", 90),
  CURRENT_TIMESTAMP
FROM "users" u
WHERE u."purchase_discount" > 0
  -- NOT just the deterministic id: once the application has run, it writes
  -- grants with generated ids and mirrors an unrestricted one into this same
  -- column. Keyed on the id alone, a replay would hand that user a SECOND
  -- unspent grant — and the resurrected one carries no plan list and no
  -- expiry, stripping exactly the restrictions this table exists to hold.
  AND NOT EXISTS (
    SELECT 1 FROM "user_pending_discounts" d
    WHERE d."user_id" = u."id" AND d."consumed_at" IS NULL
  )
ON CONFLICT DO NOTHING;

RESET lock_timeout;
