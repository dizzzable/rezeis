-- A scheduled broadcast becomes a RECORD, not just a delayed job in Redis.
--
-- WHAT WAS WRONG. "Schedule" was implemented as a BullMQ delay and nothing
-- else: no column, no status, no job id kept. The consequences were all of a
-- kind — the operator could not see that a send was pending, could not learn
-- when it would fire, and could not cancel it (the row rendered as "Draft",
-- and the cancel button is shown only for a broadcast already in flight).
-- Worse, scheduling the same broadcast twice enqueued two jobs with no
-- deterministic id, so the EARLIER one won the claim and the operator's
-- correction was silently discarded.
--
-- WHAT THESE COLUMNS BUY. `scheduled_at` is the intent, written in the same
-- request that enqueues the job, so the panel can show it and a reconciler can
-- find a schedule whose job is gone. `queue_job_id` makes cancel and reschedule
-- an addressed operation instead of a scan of the whole queue.
--
-- The SCHEDULED status is what stops a pending send from looking like a draft.
-- The delivery claim widens to accept it, so a fired job still transitions
-- SCHEDULED -> PROCESSING exactly as DRAFT -> PROCESSING did.
--
-- Replay-safe throughout: every statement is guarded, so a run interrupted by
-- the lock timeout below can simply be repeated.
SET lock_timeout = '5s';

-- Added in its own statement: PostgreSQL refuses to use an enum label inside
-- the same transaction that created it. Nothing below needs the label, only
-- the type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'SCHEDULED'
      AND enumtypid = 'public."BroadcastStatus"'::regtype
  ) THEN
    ALTER TYPE "BroadcastStatus" ADD VALUE 'SCHEDULED';
  END IF;
END
$$;

ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "scheduled_at" TIMESTAMPTZ(3);
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "queue_job_id" TEXT;

COMMENT ON COLUMN "broadcasts"."scheduled_at" IS
  'When a scheduled send is due. NULL for an immediate send. Written in the same request that enqueues the delayed job, so the intent survives a Redis that does not.';
COMMENT ON COLUMN "broadcasts"."queue_job_id" IS
  'BullMQ job id of the pending start job, so cancel and reschedule address it directly instead of scanning the queue.';

-- The reconciler looks for schedules whose time has passed. Partial, because
-- the overwhelming majority of rows have no schedule at all.
CREATE INDEX IF NOT EXISTS "broadcasts_scheduled_at_idx"
  ON "broadcasts" ("scheduled_at")
  WHERE "scheduled_at" IS NOT NULL;

RESET lock_timeout;
