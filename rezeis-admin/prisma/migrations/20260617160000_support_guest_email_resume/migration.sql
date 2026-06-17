-- Email continuity (Phase 4): a secondary "resume" token hash for the link
-- emailed to a guest on an operator reply. Lets the visitor return from a
-- new device without rotating the cookie token.

ALTER TABLE "support_guests" ADD COLUMN "email_resume_hash" TEXT;

CREATE UNIQUE INDEX "support_guests_email_resume_hash_key"
    ON "support_guests"("email_resume_hash");
