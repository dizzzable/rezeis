-- Request-level idempotency for logical checkout attempts (add-on/renewal).
-- Additive only: new nullable columns + a unique index. PostgreSQL treats
-- NULLs as distinct, so pre-existing keyless transactions never collide.

-- AlterTable
ALTER TABLE "transactions"
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "checkout_fingerprint" TEXT,
  ADD COLUMN "checkout_url" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "transactions_user_id_idempotency_key_key"
  ON "transactions"("user_id", "idempotency_key");
