-- Support document requests (Phase 3)
-- An operator can ask a visitor for proof/identity in-conversation; the ask
-- is also rendered as a SYSTEM message (uses the new message metadata column).

CREATE TYPE "SupportDocRequestKind" AS ENUM ('PAYMENT_PROOF', 'DOCUMENT', 'LOGIN', 'OTHER');
CREATE TYPE "SupportDocRequestStatus" AS ENUM ('PENDING', 'FULFILLED', 'CANCELLED');

-- SYSTEM messages / doc-request references live in this optional JSON blob.
ALTER TABLE "support_ticket_messages" ADD COLUMN "metadata" JSONB;

CREATE TABLE "support_document_requests" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "kind" "SupportDocRequestKind" NOT NULL,
    "label" TEXT NOT NULL,
    "status" "SupportDocRequestStatus" NOT NULL DEFAULT 'PENDING',
    "fulfilled_message_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_document_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_document_requests_ticket_id_idx" ON "support_document_requests"("ticket_id");
CREATE INDEX "support_document_requests_status_idx" ON "support_document_requests"("status");

ALTER TABLE "support_document_requests"
    ADD CONSTRAINT "support_document_requests_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
