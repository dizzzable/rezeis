-- Gamification / Quests module — additive. New enums + 3 tables. No changes to
-- existing tables (points reuse `users.points`). Idempotent: enum creation is
-- guarded (Postgres has no CREATE TYPE IF NOT EXISTS) and tables use
-- CREATE TABLE IF NOT EXISTS so a re-apply after a rolled-back failure is safe.

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "QuestType" AS ENUM ('LINK_TELEGRAM', 'LINK_EMAIL', 'INVITE_FRIENDS', 'SUBSCRIBE_CHANNEL', 'PARTNER_TASK', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "QuestRewardType" AS ENUM ('POINTS', 'DAYS', 'PROMOCODE', 'DISCOUNT', 'TRAFFIC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "QuestRepeat" AS ENUM ('ONCE', 'REPEATABLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "QuestIconKind" AS ENUM ('PRESET', 'SVG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "QuestDaysFallback" AS ENUM ('GRANT_TRIAL', 'MINT_PROMOCODE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "QuestCompletionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CLAIMED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── quests ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quests" (
  "id"                     TEXT NOT NULL,
  "type"                   "QuestType" NOT NULL,
  "title"                  JSONB NOT NULL DEFAULT '{}',
  "description"            JSONB NOT NULL DEFAULT '{}',
  "icon_kind"              "QuestIconKind" NOT NULL DEFAULT 'PRESET',
  "icon_ref"               TEXT NOT NULL DEFAULT '',
  "reward_type"            "QuestRewardType" NOT NULL,
  "reward_amount"          INTEGER NOT NULL DEFAULT 0,
  "reward_plan_id"         TEXT,
  "days_fallback"          "QuestDaysFallback" NOT NULL DEFAULT 'MINT_PROMOCODE',
  "audience_filter"        JSONB,
  "repeat"                 "QuestRepeat" NOT NULL DEFAULT 'ONCE',
  "cooldown_hours"         INTEGER,
  "start_at"               TIMESTAMPTZ(3),
  "end_at"                 TIMESTAMPTZ(3),
  "max_completions_global" INTEGER,
  "issued_count"           INTEGER NOT NULL DEFAULT 0,
  "params"                 JSONB,
  "order"                  INTEGER NOT NULL DEFAULT 0,
  "enabled"                BOOLEAN NOT NULL DEFAULT false,
  "created_by"             TEXT,
  "created_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "quests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "quests_enabled_idx" ON "quests" ("enabled");
CREATE INDEX IF NOT EXISTS "quests_type_idx" ON "quests" ("type");
CREATE INDEX IF NOT EXISTS "quests_order_idx" ON "quests" ("order");

-- ── quest_completions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quest_completions" (
  "id"               TEXT NOT NULL,
  "quest_id"         TEXT NOT NULL,
  "user_id"          TEXT NOT NULL,
  "period_key"       TEXT NOT NULL DEFAULT '',
  "status"           "QuestCompletionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "progress"         INTEGER NOT NULL DEFAULT 0,
  "verified_at"      TIMESTAMPTZ(3),
  "completed_at"     TIMESTAMPTZ(3),
  "claimed_at"       TIMESTAMPTZ(3),
  "reward_issued_at" TIMESTAMPTZ(3),
  "reward_snapshot"  JSONB,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "quest_completions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "quest_completions_quest_id_user_id_period_key_key"
  ON "quest_completions" ("quest_id", "user_id", "period_key");
CREATE INDEX IF NOT EXISTS "quest_completions_user_id_idx" ON "quest_completions" ("user_id");
CREATE INDEX IF NOT EXISTS "quest_completions_status_idx" ON "quest_completions" ("status");
CREATE INDEX IF NOT EXISTS "quest_completions_quest_id_status_idx" ON "quest_completions" ("quest_id", "status");
-- Serves the reward reconciler scan: WHERE status='CLAIMED' AND reward_issued_at IS NULL.
CREATE INDEX IF NOT EXISTS "quest_completions_status_reward_issued_at_idx" ON "quest_completions" ("status", "reward_issued_at");

DO $$ BEGIN
  ALTER TABLE "quest_completions"
    ADD CONSTRAINT "quest_completions_quest_id_fkey"
    FOREIGN KEY ("quest_id") REFERENCES "quests" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "quest_completions"
    ADD CONSTRAINT "quest_completions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── quest_icon_assets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quest_icon_assets" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "svg"         TEXT NOT NULL,
  "size_bytes"  INTEGER NOT NULL,
  "uploaded_by" TEXT,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quest_icon_assets_pkey" PRIMARY KEY ("id")
);
