-- Realtime Phase 1: Force-password-change flag for admin accounts +
-- IP-based access blocklist used by manual blocks and (future)
-- automation rules.

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "blocked_ips" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_by_id" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "blocked_ips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blocked_ips_address_key" ON "blocked_ips"("address");

-- CreateIndex
CREATE INDEX "blocked_ips_source_idx" ON "blocked_ips"("source");

-- CreateIndex
CREATE INDEX "blocked_ips_expires_at_idx" ON "blocked_ips"("expires_at");

-- CreateIndex
CREATE INDEX "blocked_ips_created_at_idx" ON "blocked_ips"("created_at");
