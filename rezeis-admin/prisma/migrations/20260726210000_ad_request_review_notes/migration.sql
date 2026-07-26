-- The operator's decision note on a partner advertising request.
--
-- Deliberately not reusing `notes`: that column holds the partner's own message,
-- and overwriting it with a rejection reason would erase the context the decision
-- was based on. The partner now receives this text with the status notification.
ALTER TABLE "ad_placement_requests" ADD COLUMN IF NOT EXISTS "review_notes" TEXT;
