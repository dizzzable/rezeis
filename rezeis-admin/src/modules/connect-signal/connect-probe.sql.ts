/**
 * The probe's and the health's statements — pure SQL builders, so the
 * PostgreSQL spec runs exactly what the services run.
 *
 * Every "now" is bound (see `connect-sql.ts`, "Time: NEVER now()").
 */
import { Prisma } from '@prisma/client';

import { type ConnectHelpSettingsView } from './connect-help-settings';
import {
  becamePaidAnchorSql,
  connectHorizonSql,
  CONNECT_VERIFICATION_MAX_AGE_MS,
  trialBucketSql,
} from './connect-sql';
import {
  CONNECT_HELP_CATCH_UP_MS,
  CONNECT_HORIZON_MS,
  CONNECT_PROBE_BACKOFF_AFTER,
  CONNECT_PROBE_BACKOFF_CAP_MS,
  CONNECT_PROBE_BACKOFF_STEP_MS,
  CONNECT_PROBE_DUE_AHEAD_MS,
  CONNECT_PROBE_RECHECK_MS,
} from './connect-signal.constants';

/** One subscription the probe may read, as `probeCandidatesSql` returns it. */
export interface ProbeCandidateRow {
  readonly id: string;
  readonly userId: string;
  readonly remnawaveId: string;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
  readonly configUrl: string | null;
  readonly checkedAt: Date | null;
  readonly dueSoon: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * "The sender will decide this subscription within the next hour": it has not
 * been decided, and its moment — the payment that made it paid, or (with
 * trials switched on) its grant — plus the operator's N hours falls before an
 * hour from now and inside the sender's 72-hour catch-up. `false` while the
 * automatic help is off.
 */
function dueSoonSql(now: Date, settings: ConnectHelpSettingsView): Prisma.Sql {
  if (!settings.enabled) return Prisma.sql`false`;
  const delayMs = settings.delayHours * HOUR_MS;
  const dueBy = new Date(now.getTime() + CONNECT_PROBE_DUE_AHEAD_MS - delayMs);
  const windowStart = new Date(now.getTime() - delayMs - CONNECT_HELP_CATCH_UP_MS);
  const trialArm = settings.includeTrials
    ? Prisma.sql`
        OR ("s"."created_at" <= ${dueBy} AND "s"."created_at" >= ${windowStart} AND ${trialBucketSql('s')})`
    : Prisma.empty;
  return Prisma.sql`("c"."help_decided_at" IS NULL AND (
      EXISTS (SELECT 1 FROM ${becamePaidAnchorSql()} "a"
               WHERE "a"."subscription_id" = "s"."id"
                 AND "a"."anchor_at" <= ${dueBy}
                 AND "a"."anchor_at" >= ${windowStart})${trialArm}))`;
}

/**
 * What the probe may read at all: live, with a profile, in the horizon, not
 * known to have connected, not reported missing since the row last changed,
 * and not backing off (from 3 consecutive failures: 2^failures × 10 min after
 * the last one, at most 24 h).
 */
function eligibleSql(now: Date): Prisma.Sql {
  const since = new Date(now.getTime() - CONNECT_HORIZON_MS);
  return Prisma.sql`
      FROM ${connectHorizonSql(since)} "h"
      JOIN "subscriptions" "s" ON "s"."id" = "h"."subscription_id"
      LEFT JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "s"."id"
     WHERE "s"."status" IN ('ACTIVE', 'LIMITED')
       AND "s"."remnawave_id" IS NOT NULL
       AND "c"."first_connected_at" IS NULL
       AND ("c"."profile_missing_at" IS NULL OR "c"."profile_missing_at" < "s"."updated_at")
       AND ("c"."check_failures" IS NULL
            OR "c"."check_failures" < ${CONNECT_PROBE_BACKOFF_AFTER}
            OR "c"."updated_at" <= ${now}::timestamptz - LEAST(
                 power(2, LEAST("c"."check_failures", 12)) * ${CONNECT_PROBE_BACKOFF_STEP_MS / 1000}::double precision
                   * interval '1 second',
                 ${CONNECT_PROBE_BACKOFF_CAP_MS / 1000}::double precision * interval '1 second'))`;
}

/**
 * The next batch: the eligible subscriptions not read successfully within the
 * last hour (unless the sender is about to decide them), the sender's next
 * hour first, then the never-read and the longest-unread, then the newest.
 */
export function probeCandidatesSql(input: {
  readonly now: Date;
  readonly settings: ConnectHelpSettingsView;
  readonly limit: number;
}): Prisma.Sql {
  const recheckBefore = new Date(input.now.getTime() - CONNECT_PROBE_RECHECK_MS);
  const dueSoon = dueSoonSql(input.now, input.settings);
  return Prisma.sql`
    SELECT "s"."id" AS "id",
           "s"."user_id" AS "userId",
           "s"."remnawave_id" AS "remnawaveId",
           "s"."remnawave_panel_id" AS "remnawavePanelId",
           "s"."remnawave_panel_username" AS "remnawavePanelUsername",
           "s"."config_url" AS "configUrl",
           "c"."checked_at" AS "checkedAt",
           ${dueSoon} AS "dueSoon"
    ${eligibleSql(input.now)}
       AND ("c"."checked_at" IS NULL OR "c"."checked_at" < ${recheckBefore} OR ${dueSoon})
     ORDER BY "dueSoon" DESC, "c"."checked_at" ASC NULLS FIRST, "s"."created_at" DESC, "s"."id" ASC
     LIMIT ${input.limit}`;
}

/**
 * How many eligible subscriptions were never tried at all — no successful
 * read and no failed one. Zero means the first pass over the backlog is done.
 */
export function probeBacklogSql(now: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS "backlog"
    ${eligibleSql(now)}
       AND "c"."checked_at" IS NULL
       AND COALESCE("c"."check_failures", 0) = 0`;
}

/** One row of {@link coverageSql}. */
export interface ConnectCoverageRow {
  /** Live subscriptions with a profile in the 30-day horizon. */
  readonly total: number;
  /** Of them, known to have connected. */
  readonly connected: number;
  /** Of them, verified NOT connected within the last 24 h. */
  readonly verified: number;
}

/** How much of the horizon the signal can currently vouch for. */
export function coverageSql(now: Date): Prisma.Sql {
  const since = new Date(now.getTime() - CONNECT_HORIZON_MS);
  const freshSince = new Date(now.getTime() - CONNECT_VERIFICATION_MAX_AGE_MS);
  return Prisma.sql`
    SELECT count(*)::int AS "total",
           count(*) FILTER (WHERE "c"."first_connected_at" IS NOT NULL)::int AS "connected",
           count(*) FILTER (
             WHERE "c"."first_connected_at" IS NULL
               AND "c"."checked_at" >= ${freshSince}
               AND ("c"."profile_missing_at" IS NULL OR "c"."profile_missing_at" < "c"."checked_at")
           )::int AS "verified"
      FROM ${connectHorizonSql(since)} "h"
      JOIN "subscriptions" "s" ON "s"."id" = "h"."subscription_id"
      LEFT JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "s"."id"
     WHERE "s"."status" IN ('ACTIVE', 'LIMITED')
       AND "s"."remnawave_id" IS NOT NULL`;
}

/**
 * The newest `user.*` webhook of the last 24 hours, if any. The webhook stores
 * every event it accepts before acting on it (`remnawave_webhook_events`), so
 * that table already IS the record of what arrived — no second write per event.
 * Walks `created_at` backwards through one day at most.
 *
 * "user.*" exactly as the webhook normalises names: a dotted `user.…`, or an
 * undotted `USER_…` (which it reads as `user.…`). `user_hwid_devices.added` is
 * neither — it carries no traffic block of the profile.
 */
export function lastUserWebhookSql(now: Date, freshMs: number): Prisma.Sql {
  const since = new Date(now.getTime() - freshMs);
  return Prisma.sql`
    SELECT "created_at" AS "at"
      FROM "remnawave_webhook_events"
     WHERE "created_at" >= ${since}
       AND (left(lower("event_type"), 5) = 'user.'
            OR (left(lower("event_type"), 5) = 'user_' AND strpos("event_type", '.') = 0))
     ORDER BY "created_at" DESC
     LIMIT 1`;
}

/** Hours the first pass still needs at the probe's pace, rounded up. */
export function firstPassHours(backlog: number, perCycle: number, cycleMs: number): number {
  if (backlog <= 0) return 0;
  return Math.ceil((Math.ceil(backlog / perCycle) * cycleMs) / HOUR_MS);
}
