-- Support message attachments (Phase 3)
-- Files are stored on disk under SUPPORT_ATTACHMENTS_DIR/<ticketId>/<stored_name>.
-- Only metadata lives here; the on-disk name is a CUID (no path separators).

CREATE TABLE "support_attachments" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "stored_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_attachments_message_id_idx" ON "support_attachments"("message_id");

ALTER TABLE "support_attachments"
    ADD CONSTRAINT "support_attachments_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "support_ticket_messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
