-- Keep imported partner-ledger history idempotent without changing live accrual semantics.
ALTER TABLE "partner_transactions"
ADD COLUMN "source_key" TEXT;

CREATE UNIQUE INDEX "partner_transactions_source_key_key"
ON "partner_transactions"("source_key");
