-- Saved payment methods for YooKassa (and future gateways) autopayments.
-- Provider method id is unique per gateway; unbind is a local soft-deactivate
-- because YooKassa does not expose a "detach card" API for merchants.
CREATE TABLE "saved_payment_methods" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "gateway_type" "PaymentGatewayType" NOT NULL,
    "provider_method_id" TEXT NOT NULL,
    "method_type" TEXT NOT NULL,
    "title" TEXT,
    "card_last4" TEXT,
    "card_first6" TEXT,
    "card_expiry_month" TEXT,
    "card_expiry_year" TEXT,
    "card_issuer_country" TEXT,
    "card_product" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "unbound_at" TIMESTAMPTZ(3),
    "source_transaction_id" TEXT,
    "source_gateway_id" TEXT,
    "raw_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_payment_methods_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_payment_methods_gateway_type_provider_method_id_key"
  ON "saved_payment_methods"("gateway_type", "provider_method_id");

CREATE INDEX "saved_payment_methods_user_id_idx"
  ON "saved_payment_methods"("user_id");

CREATE INDEX "saved_payment_methods_user_id_is_active_idx"
  ON "saved_payment_methods"("user_id", "is_active");

CREATE INDEX "saved_payment_methods_gateway_type_idx"
  ON "saved_payment_methods"("gateway_type");

ALTER TABLE "saved_payment_methods"
  ADD CONSTRAINT "saved_payment_methods_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
