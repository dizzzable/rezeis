-- Repeat charges the PROVIDER runs (19.09.2026): Platega's recurring SBP
-- subscriptions, RollyPay's next.
--
-- ЮKassa hands the panel a saved method and the panel decides when to charge
-- (`saved_payment_methods`). Platega fixes the amount and the period when the
-- subscription is created and charges on its own schedule; the panel only
-- turns each successful charge into a delivered renewal, and can cancel. So a
-- row of its own: the provider's id, the frozen amount and period, and how many
-- of the provider's successful charges were already applied.
--
-- The user key is SET NULL on delete, not CASCADE: a deleted account must not
-- take with it the only record that the provider is still charging someone.
-- The panel's sweep cancels an orphaned row at the provider.
--
-- A new, empty table: nothing is backfilled. Replay-safe throughout, so a
-- start that timed out on the lock re-applies it (`is_auto_recoverable_migration`
-- in `docker-entrypoint.sh`). The foreign key briefly locks "users";
-- `lock_timeout` bounds that wait.

SET lock_timeout = '5s';

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProviderSubscriptionStatus') THEN
    CREATE TYPE "ProviderSubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'FAILED');
  END IF;
END
$do$;

CREATE TABLE IF NOT EXISTS "provider_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "gateway_type" "PaymentGatewayType" NOT NULL,
    "provider_subscription_id" TEXT NOT NULL,
    "status" "ProviderSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "provider_status" TEXT,
    "subscription_id" TEXT,
    "plan_id" TEXT NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "list_amount" DECIMAL(20,8),
    "currency" "Currency" NOT NULL,
    "interval_unit" TEXT NOT NULL,
    "interval_count" INTEGER NOT NULL,
    "first_transaction_id" TEXT NOT NULL,
    "applied_charge_count" INTEGER NOT NULL DEFAULT 0,
    "next_charge_at" TIMESTAMPTZ(3),
    "last_charge_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" TEXT,
    "consent_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_subscriptions_first_transaction_id_key"
  ON "provider_subscriptions"("first_transaction_id");

CREATE INDEX IF NOT EXISTS "provider_subscriptions_user_id_status_idx"
  ON "provider_subscriptions"("user_id", "status");

CREATE INDEX IF NOT EXISTS "provider_subscriptions_status_next_charge_at_idx"
  ON "provider_subscriptions"("status", "next_charge_at");

CREATE UNIQUE INDEX IF NOT EXISTS "provider_subscriptions_gateway_type_provider_subscription_i_key"
  ON "provider_subscriptions"("gateway_type", "provider_subscription_id");

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_subscriptions_user_id_fkey'
  ) THEN
    ALTER TABLE "provider_subscriptions"
      ADD CONSTRAINT "provider_subscriptions_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$do$;

-- `migrate deploy` applies every pending migration over ONE connection, so the
-- bound is this file's alone.
RESET lock_timeout;
