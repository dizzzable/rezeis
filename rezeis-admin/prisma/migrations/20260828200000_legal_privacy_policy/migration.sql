-- A third legal document: the privacy policy.
--
-- WHY NOW. The cabinet began deriving device signals — an install id it stores
-- and a digest of what the graphics and audio stacks do — to notice a banned
-- person coming back on the same machine. Whatever an operator wants to say
-- about that belongs in a privacy policy, and until this row exists there is
-- nowhere for them to say it: `LegalDocumentKey` held exactly two values and no
-- surface in either repo could invent a third.
--
-- WHY NOT FOLD IT INTO THE USER AGREEMENT. Because it is the document people
-- go looking for by name. An agreement that also contains the privacy terms
-- satisfies a lawyer and defeats the reader, and the cabinet lists documents by
-- title — one titled "User agreement" is not one somebody scanning for privacy
-- will open.
--
-- NOTHING CHANGES ON APPLY. No row is created here, and `is_active` defaults to
-- false, so an install that never touches this keeps asking for exactly the
-- consents it asks for today. The document becomes a required tick at sign-up
-- only once an operator has written a body and switched it on — which is the
-- same gate the other two pass through, and the reason activation refuses an
-- empty body (`LegalDocumentsService.update`).
--
-- LIVE SAFETY. `ALTER TYPE ... ADD VALUE` takes no lock on any table and cannot
-- block a reader. It is not transactional, which is why it is guarded rather
-- than wrapped: re-applying this file after a partial run must not fail on a
-- label that is already there.
--
-- ORDER. PostgreSQL appends the new label, so `enum_range` puts it last. That
-- is display order nowhere: both repos render documents in the order their own
-- `LEGAL_DOCUMENT_KEYS` array declares, and the column is only ever compared
-- for equality.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'LegalDocumentKey' AND e.enumlabel = 'PRIVACY_POLICY'
  ) THEN
    ALTER TYPE "LegalDocumentKey" ADD VALUE 'PRIVACY_POLICY';
  END IF;
END
$$;

SET lock_timeout = 0;
