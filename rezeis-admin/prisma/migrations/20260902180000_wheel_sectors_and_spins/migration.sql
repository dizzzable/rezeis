-- The wheel itself: its sectors, the key pools a sector draws from, and the
-- journal of every spin.
--
-- WHY THERE IS NO "wheel" TABLE. One wheel was asked for, with configurable
-- sectors, odds and slot count. A wheel table holding exactly one row forever
-- would add a join and a "which wheel" filter to every query in order to
-- express nothing at all. A second wheel, if it is ever wanted, arrives as a
-- column on `wheel_sectors` plus a settings block.
--
-- WHY WEIGHTS AND NOT PERCENTS. Percents stored per row have to add up to a
-- hundred, and no constraint can make them: an operator adds a tenth sector
-- and the wheel silently sums to 103 %. Weights are relative, the percentage
-- is `weight / SUM(weight)`, and it is exactly 100 by construction. The panel
-- shows the derived figure live while the operator edits; nothing is ever
-- shown to the person spinning.
--
-- WHY TWO KINDS OF CEILING. `max_wins_per_user` is "one Steam key per person"
-- and "the permanent discount, once"; `max_wins_total` is the size of a
-- jackpot. They fail differently and are enforced differently: the per-user
-- one is a count over `wheel_spins` taken while the spinner's own row is
-- locked, the global one is a conditional increment of `won_count` that tests
-- the ceiling in the same statement.
--
-- WHY THE SNAPSHOT. `wheel_spins.sector_snapshot` keeps what the sector WAS
-- at the moment of the draw. A sector renamed or re-priced a month later must
-- not rewrite what somebody remembers winning, and a sector deleted entirely
-- must not erase it.
--
-- NOTHING IS ENABLED. Every sector arrives `enabled = false` and the tables
-- start empty, so this migration changes nothing anybody can see. The wheel
-- becomes reachable only once an operator configures it.

SET lock_timeout = '5s';

-- == ENUMS ===================================================================

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WheelSectorKind') THEN
    CREATE TYPE "WheelSectorKind" AS ENUM (
      'NOTHING',
      'POINTS',
      'SPINS',
      'DAYS',
      'TRAFFIC',
      'DISCOUNT',
      'PROMOCODE',
      'KEY',
      'MANUAL'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WheelRarity') THEN
    CREATE TYPE "WheelRarity" AS ENUM ('COMMON', 'RARE', 'EPIC', 'LEGENDARY');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WheelSpinPayment') THEN
    CREATE TYPE "WheelSpinPayment" AS ENUM ('FREE', 'BALANCE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WheelSpinStatus') THEN
    CREATE TYPE "WheelSpinStatus" AS ENUM ('EMPTY', 'SETTLED', 'PENDING');
  END IF;
END
$do$;

-- == KEY POOLS ===============================================================

CREATE TABLE IF NOT EXISTS "wheel_key_pools" (
  "id"         TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "note"       TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wheel_key_pools_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "wheel_key_pools" IS
  'A named batch of one-use secrets - Steam keys, gift codes - that a KEY sector draws from.';

-- == SECTORS =================================================================

CREATE TABLE IF NOT EXISTS "wheel_sectors" (
  "id"                  TEXT NOT NULL,
  "kind"                "WheelSectorKind" NOT NULL,
  "title"               JSONB NOT NULL DEFAULT '{}',
  "icon_kind"           "QuestIconKind" NOT NULL DEFAULT 'PRESET',
  "icon_ref"            TEXT NOT NULL DEFAULT '',
  "rarity"              "WheelRarity" NOT NULL DEFAULT 'COMMON',
  "weight"              INTEGER NOT NULL DEFAULT 0,
  "amount"              INTEGER NOT NULL DEFAULT 0,
  "promo_reward_type"   "PromocodeRewardType",
  "promo_plan_id"       TEXT,
  "promo_plan_ids"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "promo_lifetime"      INTEGER,
  "key_pool_id"         TEXT,
  "manual_instructions" TEXT,
  "max_wins_per_user"   INTEGER,
  "max_wins_total"      INTEGER,
  "won_count"           INTEGER NOT NULL DEFAULT 0,
  "order"               INTEGER NOT NULL DEFAULT 0,
  "enabled"             BOOLEAN NOT NULL DEFAULT false,
  "created_by"          TEXT,
  "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wheel_sectors_pkey" PRIMARY KEY ("id")
);

-- The draw's only read: the enabled sectors, in wheel order.
CREATE INDEX IF NOT EXISTS "wheel_sectors_enabled_order_idx"
  ON "wheel_sectors" ("enabled", "order");
CREATE INDEX IF NOT EXISTS "wheel_sectors_key_pool_id_idx"
  ON "wheel_sectors" ("key_pool_id");

COMMENT ON COLUMN "wheel_sectors"."weight" IS
  'Relative weight of the draw, NOT a percent. The percentage is derived as weight / SUM(weight) so it always totals exactly 100. 0 = on the wheel but never drawn.';
COMMENT ON COLUMN "wheel_sectors"."max_wins_per_user" IS
  'How many times one person may ever win this sector. NULL = no ceiling. 1 is how "one key per person" is expressed.';
COMMENT ON COLUMN "wheel_sectors"."won_count" IS
  'Guarded counter incremented conditionally against max_wins_total in the same statement that tests it - a read-then-check would let two simultaneous spins past the last remaining prize.';
COMMENT ON COLUMN "wheel_sectors"."rarity" IS
  'Visual tier only: colour, glow, how loudly the win is announced. It carries no odds; the weight does, and the odds are never shown to anyone spinning.';

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wheel_sectors_key_pool_id_fkey'
  ) THEN
    ALTER TABLE "wheel_sectors"
      ADD CONSTRAINT "wheel_sectors_key_pool_id_fkey"
      FOREIGN KEY ("key_pool_id") REFERENCES "wheel_key_pools"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$do$;

-- == SPINS ===================================================================

CREATE TABLE IF NOT EXISTS "wheel_spins" (
  "id"              TEXT NOT NULL,
  "user_id"         TEXT NOT NULL,
  "sector_id"       TEXT,
  "sector_snapshot" JSONB NOT NULL,
  "kind"            "WheelSectorKind" NOT NULL,
  "amount"          INTEGER NOT NULL DEFAULT 0,
  "status"          "WheelSpinStatus" NOT NULL,
  "paid_with"       "WheelSpinPayment" NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "outcome"         JSONB,
  "settled_at"      TIMESTAMPTZ(3),
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wheel_spins_pkey" PRIMARY KEY ("id")
);

-- A spin request replayed after a dropped connection carries the same key, so
-- the second insert is refused and the caller is handed the spin it already
-- has. A lost response never costs a second spin.
CREATE UNIQUE INDEX IF NOT EXISTS "wheel_spins_user_id_idempotency_key_key"
  ON "wheel_spins" ("user_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "wheel_spins_user_id_created_at_idx"
  ON "wheel_spins" ("user_id", "created_at" DESC);
-- "How many times has this person won this sector" - the per-user ceiling.
CREATE INDEX IF NOT EXISTS "wheel_spins_user_id_sector_id_idx"
  ON "wheel_spins" ("user_id", "sector_id");
-- The operator's queue: what is owed and not yet handed over.
CREATE INDEX IF NOT EXISTS "wheel_spins_status_created_at_idx"
  ON "wheel_spins" ("status", "created_at");

COMMENT ON TABLE "wheel_spins" IS
  'One row per spin, however it was paid for. This is NOT the spin ledger: the ledger explains the balance and has no row for a free spin, which never touches it.';
COMMENT ON COLUMN "wheel_spins"."sector_snapshot" IS
  'What the sector was at the moment of the draw. A sector edited or deleted later must not rewrite what somebody remembers winning.';
COMMENT ON COLUMN "wheel_spins"."status" IS
  'EMPTY = nothing to give. SETTLED = the prize was applied in the spin transaction. PENDING = owed and not yet handed over (a manual jackpot, a key).';

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wheel_spins_user_id_fkey'
  ) THEN
    ALTER TABLE "wheel_spins"
      ADD CONSTRAINT "wheel_spins_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wheel_spins_sector_id_fkey'
  ) THEN
    ALTER TABLE "wheel_spins"
      ADD CONSTRAINT "wheel_spins_sector_id_fkey"
      FOREIGN KEY ("sector_id") REFERENCES "wheel_sectors"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$do$;

-- == KEYS ====================================================================

CREATE TABLE IF NOT EXISTS "wheel_keys" (
  "id"                 TEXT NOT NULL,
  "pool_id"            TEXT NOT NULL,
  "value"              TEXT NOT NULL,
  "claimed_by_user_id" TEXT,
  "claimed_spin_id"    TEXT,
  "claimed_at"         TIMESTAMPTZ(3),
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wheel_keys_pkey" PRIMARY KEY ("id")
);

-- The same secret cannot be loaded into one pool twice: a paste an operator
-- repeats would otherwise hand two people the same key.
CREATE UNIQUE INDEX IF NOT EXISTS "wheel_keys_pool_id_value_key"
  ON "wheel_keys" ("pool_id", "value");
-- One spin claims at most one key.
CREATE UNIQUE INDEX IF NOT EXISTS "wheel_keys_claimed_spin_id_key"
  ON "wheel_keys" ("claimed_spin_id");
-- The pick: the oldest key in a pool.
CREATE INDEX IF NOT EXISTS "wheel_keys_pool_id_created_at_idx"
  ON "wheel_keys" ("pool_id", "created_at");
CREATE INDEX IF NOT EXISTS "wheel_keys_claimed_by_user_id_idx"
  ON "wheel_keys" ("claimed_by_user_id");

COMMENT ON COLUMN "wheel_keys"."claimed_at" IS
  'NULL while the key is still in the pool. A key is claimed by an UPDATE whose WHERE still says it is free, so two people spinning at the same instant cannot be handed the same one.';

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wheel_keys_pool_id_fkey'
  ) THEN
    ALTER TABLE "wheel_keys"
      ADD CONSTRAINT "wheel_keys_pool_id_fkey"
      FOREIGN KEY ("pool_id") REFERENCES "wheel_key_pools"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wheel_keys_claimed_by_user_id_fkey'
  ) THEN
    ALTER TABLE "wheel_keys"
      ADD CONSTRAINT "wheel_keys_claimed_by_user_id_fkey"
      FOREIGN KEY ("claimed_by_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wheel_keys_claimed_spin_id_fkey'
  ) THEN
    ALTER TABLE "wheel_keys"
      ADD CONSTRAINT "wheel_keys_claimed_spin_id_fkey"
      FOREIGN KEY ("claimed_spin_id") REFERENCES "wheel_spins"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$do$;

-- == SETTINGS ================================================================
--
-- The wheel's own block, OFF when absent: an update must not start a giveaway
-- behind the operator's back. Same rule, same shape, as the points block.

ALTER TABLE "settings"
  ADD COLUMN IF NOT EXISTS "wheel_settings" JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN "settings"."wheel_settings" IS
  'The wheel: { enabled?: boolean, freeSpinCooldownHours?: number|null, spinPricePoints?: number|null }. Absent or empty means off.';

-- The spin ledger's idempotency handle is the spin REQUEST handle, not the
-- spin id: the spin row is written at the end of the transaction, after the
-- payment the key exists to guard.
COMMENT ON COLUMN "spin_ledger"."reference_key" IS
  'Idempotency handle, unique per source: the spin request handle for SPENT and for the WHEEL_PRIZE it produced, the purchase id for PURCHASED. NULL for an operator adjustment. wheel_spins.idempotency_key carries the same value.';

RESET lock_timeout;
