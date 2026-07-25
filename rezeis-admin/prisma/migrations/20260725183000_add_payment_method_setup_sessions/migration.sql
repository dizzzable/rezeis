-- A standalone YooKassa binding is not a monetary transaction. Keep its
-- lifecycle, consent and provider token separate from purchase history.

-- Lifecycle of a standalone payment-method binding. Modeled as a Postgres enum
-- (like the other lifecycle columns in this schema) so the DB rejects typos and
-- the ORM types stay exhaustive.
CREATE TYPE "PaymentMethodSetupStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'INACTIVE',
  'FAILED',
  'EXPIRED'
);

CREATE TABLE "payment_method_setups" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "gateway_type" "PaymentGatewayType" NOT NULL,
  "status" "PaymentMethodSetupStatus" NOT NULL DEFAULT 'PENDING',
  "provider_method_id" TEXT,
  "provider_status" TEXT,
  "consent_version" TEXT NOT NULL,
  "consent_at" TIMESTAMPTZ(3) NOT NULL,
  "consent_ip" TEXT,
  "consent_user_agent" TEXT,
  "return_url" TEXT NOT NULL,
  "raw_snapshot" JSONB,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "last_checked_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "payment_method_setups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_method_setups_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "payment_method_setups_provider_method_id_key"
  ON "payment_method_setups"("provider_method_id");
CREATE INDEX "payment_method_setups_user_id_status_idx"
  ON "payment_method_setups"("user_id", "status");
CREATE INDEX "payment_method_setups_expires_at_idx"
  ON "payment_method_setups"("expires_at");

-- At most one in-flight (PENDING) binding per user+gateway. A fast double-tap
-- or a network retry on "add card" must reuse the open session instead of
-- opening a second real bind request against YooKassa.
CREATE UNIQUE INDEX "payment_method_setups_pending_user_gateway_key"
  ON "payment_method_setups"("user_id", "gateway_type")
  WHERE "status" = 'PENDING';
