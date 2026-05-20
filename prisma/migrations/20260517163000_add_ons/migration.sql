-- CreateEnum
CREATE TYPE "AddOnType" AS ENUM ('EXTRA_TRAFFIC', 'EXTRA_DEVICES');

-- CreateTable
CREATE TABLE "add_ons" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "AddOnType" NOT NULL,
    "value" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "applicable_plan_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "add_on_prices" (
    "id" TEXT NOT NULL,
    "add_on_id" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,

    CONSTRAINT "add_on_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "add_ons_is_active_order_index_idx" ON "add_ons"("is_active", "order_index");

-- CreateIndex
CREATE INDEX "add_ons_type_idx" ON "add_ons"("type");

-- CreateIndex
CREATE UNIQUE INDEX "add_on_prices_add_on_id_currency_key" ON "add_on_prices"("add_on_id", "currency");

-- AddForeignKey
ALTER TABLE "add_on_prices" ADD CONSTRAINT "add_on_prices_add_on_id_fkey" FOREIGN KEY ("add_on_id") REFERENCES "add_ons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
