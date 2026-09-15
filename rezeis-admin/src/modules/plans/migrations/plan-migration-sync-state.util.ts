import { Prisma } from '@prisma/client';

import { PROFILE_SYNC_MAX_ATTEMPTS } from '../../profile-sync/profile-sync.constants';

/**
 * How long a FAILED profile-sync job with attempts left still counts as about to
 * be retried (spec §9 A1). BullMQ re-runs a failed attempt after a 5 s backoff
 * (`PROFILE_SYNC_BACKOFF_MS`, exponential), so a live retry touches the row well
 * inside this window; a job whose BullMQ entry was lost (Redis flushed, a worker
 * gone) stops pinning the run as pending once it has sat here this long.
 */
export const PLAN_MIGRATION_SYNC_RETRY_WINDOW_SECONDS = 5 * 60;

/** The three states a run reports a profile-sync job in. */
export type PlanMigrationSyncState = 'COMPLETED' | 'PENDING' | 'FAILED';

/**
 * THE ONE DEFINITION OF A MIGRATION SYNC JOB'S STATE, as an SQL expression over
 * a `profile_sync_jobs` row aliased `alias`. The run's `sync` counts, its
 * `SYNC_FAILED` problems and «Повторить синхронизацию» all select through it, so
 * the three can never disagree about one job:
 *
 *   COMPLETED  superseded, whatever its status — deleting a subscription
 *              supersedes its jobs without touching their status, and a newer
 *              revision supersedes an older one; nothing ever runs either again —
 *              or COMPLETED;
 *   PENDING    not superseded and PENDING or RUNNING, or FAILED with attempts left
 *              (`attempts < PROFILE_SYNC_MAX_ATTEMPTS`) and touched within
 *              {@link PLAN_MIGRATION_SYNC_RETRY_WINDOW_SECONDS}: BullMQ is about to
 *              run it again;
 *   FAILED     every other FAILED job: attempts exhausted, or its retry is gone.
 *
 * Before this, the counts grouped by raw `status`: a superseded PENDING job kept
 * `sync.pending` above zero for ever — the run never finished and the dialog
 * stayed locked — and a FAILED job BullMQ was about to retry was reported as a
 * failure the operator could do nothing about.
 *
 * `alias` is a constant in the calling code, never input.
 */
export function syncJobStateSql(alias: string): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Invalid SQL alias "${alias}"`);
  }
  const job = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(CASE
    WHEN ${job}."superseded_at" IS NOT NULL THEN 'COMPLETED'
    WHEN ${job}."status" = 'COMPLETED' THEN 'COMPLETED'
    WHEN ${job}."status" IN ('PENDING', 'RUNNING') THEN 'PENDING'
    WHEN ${job}."status" = 'FAILED'
         AND ${job}."attempts" < ${PROFILE_SYNC_MAX_ATTEMPTS}::int
         AND ${job}."updated_at" >= now() - make_interval(secs => ${PLAN_MIGRATION_SYNC_RETRY_WINDOW_SECONDS}::double precision)
      THEN 'PENDING'
    ELSE 'FAILED'
  END)`;
}
