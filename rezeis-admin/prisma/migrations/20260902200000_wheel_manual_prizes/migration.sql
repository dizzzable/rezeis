-- Manual prizes: the queue of what is owed, and the record of who settled it.
--
-- A MANUAL sector is the one prize this system must not pretend to have
-- delivered. "1000 ₽" is a bank transfer somebody makes; a T-shirt is a parcel
-- somebody posts. The wheel records the win as owed (PENDING), opens a
-- conversation so the operator can reach the winner, and waits for a human.
--
-- WHY "SETTLED" IS NOT SPLIT IN TWO. An operator handing a jackpot over and
-- the machine crediting points answer the same question the same way: nothing
-- is owed any more. Who did it is written on the row (`settled_by` is NULL for
-- the machine), which keeps every queue query a plain `status = 'PENDING'`
-- rather than a list of statuses that must be kept in step with the code.
--
-- WHY A REFUSAL DOES NOT REFUND. Whether a refusal deserves compensation is a
-- judgement about the case — abuse, an unfulfillable prize, a duplicate — and
-- the operator already has a manual spin adjustment for the cases where it
-- does. A refund written in here would pay out on every refusal, including the
-- ones aimed at somebody gaming the wheel.
--
-- NOTHING CHANGES FOR ANY EXISTING ROW. The columns are nullable, the new enum
-- value is written by nothing until an operator refuses something, and there
-- are no manual sectors on any wheel yet.

SET lock_timeout = '5s';

-- == THE REFUSAL ============================================================
--
-- ADD VALUE IF NOT EXISTS is transactional in PostgreSQL 12+ and replay-safe
-- on its own, so this needs no DO block guard.

ALTER TYPE "WheelSpinStatus" ADD VALUE IF NOT EXISTS 'REFUSED';

-- == WHO SETTLED IT, AND WHERE THE CONVERSATION IS ==========================

ALTER TABLE "wheel_spins"
  ADD COLUMN IF NOT EXISTS "settled_by" TEXT;
ALTER TABLE "wheel_spins"
  ADD COLUMN IF NOT EXISTS "settlement_note" TEXT;
ALTER TABLE "wheel_spins"
  ADD COLUMN IF NOT EXISTS "manual_ticket_id" TEXT;

COMMENT ON COLUMN "wheel_spins"."settled_by" IS
  'The admin who handed the prize over or refused it. NULL when the machine settled it, which is what separates the two without a second status.';
COMMENT ON COLUMN "wheel_spins"."settlement_note" IS
  'What the operator wrote when they settled or refused. The refusal reason is shown to the person; the issue note is for the operator record.';
COMMENT ON COLUMN "wheel_spins"."manual_ticket_id" IS
  'The support conversation opened so the operator can reach the winner. Set once and never again, which is what makes opening it safe to retry.';

-- The reverse lookup: which spin a conversation is about.
CREATE INDEX IF NOT EXISTS "wheel_spins_manual_ticket_id_idx"
  ON "wheel_spins" ("manual_ticket_id");

RESET lock_timeout;
