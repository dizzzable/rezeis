-- Anonymous support chat (Phase 2): guest-owned tickets, channel, archive,
-- and a SYSTEM message author. Hand-written per project standards.

-- AlterEnum: add SYSTEM author (for system prompts / document requests).
ALTER TYPE "SupportTicketAuthorType" ADD VALUE IF NOT EXISTS 'SYSTEM';

-- CreateEnum: how a ticket was opened.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SupportTicketChannel') THEN
    CREATE TYPE "SupportTicketChannel" AS ENUM ('CABINET', 'GUEST');
  END IF;
END
$$;

-- CreateTable: server-bound anonymous guest identity (one guest = one ticket).
CREATE TABLE "support_guests" (
    "id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_guests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_guests_secret_hash_key" ON "support_guests"("secret_hash");
CREATE INDEX "support_guests_expires_at_idx" ON "support_guests"("expires_at");

-- AlterTable: support_tickets — user becomes optional; add guest/channel/archive.
ALTER TABLE "support_tickets" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "support_tickets" ADD COLUMN "guest_id" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN "channel" "SupportTicketChannel" NOT NULL DEFAULT 'CABINET';
ALTER TABLE "support_tickets" ADD COLUMN "archived_at" TIMESTAMPTZ(3);

-- Owner exclusivity: exactly one of user_id / guest_id must be set.
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "support_tickets_owner_chk"
  CHECK (("user_id" IS NOT NULL) <> ("guest_id" IS NOT NULL));

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_guest_id_key" ON "support_tickets"("guest_id");
CREATE INDEX "support_tickets_channel_idx" ON "support_tickets"("channel");
CREATE INDEX "support_tickets_archived_at_idx" ON "support_tickets"("archived_at");

-- AddForeignKey: ticket → guest (SET NULL so deleting a guest never cascades
-- away the conversation history retained for the archive).
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "support_tickets_guest_id_fkey"
  FOREIGN KEY ("guest_id") REFERENCES "support_guests"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
