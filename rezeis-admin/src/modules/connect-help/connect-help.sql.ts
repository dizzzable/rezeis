/**
 * «Помощь с подключением» — THE SENDER'S STATEMENTS, AS SQL
 * ═══════════════════════════════════════════════════════
 * Pure `Prisma.Sql` builders, so the PostgreSQL spec runs exactly what the
 * sender runs. The bucket definitions are not restated here: "became paid"
 * and "trial or gift" come from `connect-sql.ts`, the one place they are
 * written.
 *
 * ── Time: NEVER `now()` ───────────────────────────────────────────────────
 * Every instant is a bound JS `Date`. Prisma's pg adapter stores the panel's
 * own timestamps shifted on a database whose time zone is not UTC, and a bound
 * `Date` is shifted the same way, so comparisons with it are sound while SQL
 * `now()` is off by the offset (see `connect-sql.ts`).
 *
 * ── The once-marker ───────────────────────────────────────────────────────
 * `subscription_connect_states.help_decided_at` is set by exactly one claimer:
 * `UPDATE … WHERE help_decided_at IS NULL`, one row updated = ours. Broadcast
 * staging claims with the same guard, so neither can decide a subscription the
 * other already decided — across worker replicas as much as within one.
 */
import { Prisma } from '@prisma/client';

import { type ConnectHelpSettingsView } from '../connect-signal/connect-help-settings';
import { CONNECT_HELP_CATCH_UP_MS } from '../connect-signal/connect-signal.constants';
import {
  becamePaidAnchorSql,
  HELP_OUTCOMES,
  PENDING_HELP_OUTCOMES,
  trialBucketSql,
  type HelpOutcome,
} from '../connect-signal/connect-sql';
import {
  CONNECT_HELP_CLOSING_MS,
  CONNECT_HELP_FULFILMENT_SLACK_MS,
  CONNECT_HELP_IN_FLIGHT_MS,
  CONNECT_HELP_MERGE_WINDOW_MS,
  CONNECT_HELP_SOURCE_AUTO,
} from './connect-help.constants';

const HOUR_MS = 60 * 60 * 1000;

/** `paid` — the customer paid; `trial` — a trial, a gift, a promo, a 0 ₽ checkout. */
export type ConnectHelpKind = 'paid' | 'trial';

/**
 * Which moments the sender helps now.
 *
 *   to             now − N: a purchase (or grant) is due once N hours old;
 *   from           now − N − 72 h: the catch-up — worker downtime, and the
 *                  purchases of the last three days when the switch goes on;
 *   closingBefore  from + 20 min: a candidate older than this is in its last
 *                  cycles, and an unverified one is closed out;
 *   createdSince   from − 24 h: the bound on the payment's CREATION that lets
 *                  `transactions_status_created_at_idx` serve the anchor query
 *                  (the anchor is the fulfilment, never before the creation).
 */
export interface ConnectHelpWindow {
  readonly from: Date;
  readonly to: Date;
  readonly closingBefore: Date;
  readonly createdSince: Date;
}

export function connectHelpWindow(now: Date, delayHours: number): ConnectHelpWindow {
  const to = new Date(now.getTime() - delayHours * HOUR_MS);
  const from = new Date(to.getTime() - CONNECT_HELP_CATCH_UP_MS);
  return {
    from,
    to,
    closingBefore: new Date(from.getTime() + CONNECT_HELP_CLOSING_MS),
    createdSince: new Date(from.getTime() - CONNECT_HELP_FULFILMENT_SLACK_MS),
  };
}

/** One subscription the sender looks at in a cycle. */
export interface ConnectHelpCandidateRow {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly kind: ConnectHelpKind;
  /** When it became paid (the fulfilment of its first paid money), or was granted. */
  readonly anchorAt: Date;
  /** The payment that made it paid; `null` for a trial or gift and for a resumed row. */
  readonly anchorTransactionId: string | null;
  /** Already claimed by the sender and not finished — a deferred bot step. */
  readonly inFlight: boolean;
  /** The feed row of a resumed ladder. */
  readonly eventId: string | null;
  readonly deferrals: number;
}

/**
 * What every candidate must still be: a live subscription with a profile, not
 * imported, of a customer not blocked, not known to have connected. `c` is a
 * LEFT JOIN — no state row reads as "not known to have connected", and the
 * panel re-read decides.
 */
function eligibleSql(): Prisma.Sql {
  return Prisma.sql`"s"."status" IN ('ACTIVE', 'LIMITED')
       AND "s"."remnawave_id" IS NOT NULL
       AND "s"."plan_snapshot"->>'importedFrom' IS NULL
       AND "u"."is_blocked" = false
       AND "c"."first_connected_at" IS NULL`;
}

/**
 * The cycle's candidates, oldest moment first, at most `limit`:
 *
 *   paid      the payment that made the subscription PAID (its first paid
 *             money, never a renewal — `becamePaidAnchorSql`) fulfilled inside
 *             the window;
 *   trial     with trials switched on: a subscription in «пробный или
 *             подарок» (`trialBucketSql`) created inside the window;
 *   in flight the sender's own claims whose ladder has not finished, decided
 *             within the last day — resumed with their feed row and deferrals.
 *
 * New candidates must be undecided; every candidate must still be eligible.
 */
export function connectHelpCandidatesSql(input: {
  readonly now: Date;
  readonly settings: ConnectHelpSettingsView;
  readonly limit: number;
}): Prisma.Sql {
  const window = connectHelpWindow(input.now, input.settings.delayHours);
  const inFlightSince = new Date(input.now.getTime() - CONNECT_HELP_IN_FLIGHT_MS);
  const trialArm = input.settings.includeTrials
    ? Prisma.sql`
      UNION ALL
      SELECT "s"."id", "s"."user_id", 'trial'::text, "s"."created_at", NULL::text,
             false, NULL::text, 0
        FROM "subscriptions" "s"
        JOIN "users" "u" ON "u"."id" = "s"."user_id"
        LEFT JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "s"."id"
       WHERE "s"."created_at" >= ${window.from}
         AND "s"."created_at" <= ${window.to}
         AND ${trialBucketSql('s')}
         AND ${eligibleSql()}
         AND "c"."help_decided_at" IS NULL`
    : Prisma.empty;
  const inFlightKinds = input.settings.includeTrials
    ? Prisma.sql`('paid', 'trial')`
    : Prisma.sql`('paid')`;
  return Prisma.sql`
    SELECT "subscriptionId", "userId", "kind", "anchorAt", "anchorTransactionId", "inFlight",
           "eventId", "deferrals"
      FROM (
      SELECT "s"."id" AS "subscriptionId", "s"."user_id" AS "userId", 'paid'::text AS "kind",
             "a"."anchor_at" AS "anchorAt", "a"."transaction_id" AS "anchorTransactionId",
             false AS "inFlight", NULL::text AS "eventId", 0 AS "deferrals"
        FROM ${becamePaidAnchorSql()} "a"
        JOIN "subscriptions" "s" ON "s"."id" = "a"."subscription_id"
        JOIN "users" "u" ON "u"."id" = "s"."user_id"
        LEFT JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "s"."id"
       WHERE "a"."created_at" >= ${window.createdSince}
         AND "a"."anchor_at" >= ${window.from}
         AND "a"."anchor_at" <= ${window.to}
         AND ${eligibleSql()}
         AND "c"."help_decided_at" IS NULL${trialArm}
      UNION ALL
      SELECT "s"."id", "s"."user_id", "c"."help_kind", "c"."help_anchor_at", NULL::text,
             true, "c"."help_event_id", "c"."help_deferrals"
        FROM "subscription_connect_states" "c"
        JOIN "subscriptions" "s" ON "s"."id" = "c"."subscription_id"
        JOIN "users" "u" ON "u"."id" = "s"."user_id"
       WHERE "c"."help_decided_at" >= ${inFlightSince}
         AND "c"."help_outcome" IS NULL
         AND "c"."help_source" = ${CONNECT_HELP_SOURCE_AUTO}
         AND "c"."help_kind" IN ${inFlightKinds}
         AND "c"."help_anchor_at" IS NOT NULL
         AND ${eligibleSql()}
      ) "candidate"
     ORDER BY "anchorAt" ASC, "subscriptionId" ASC
     LIMIT ${input.limit}`;
}

/** One row of {@link connectHelpRecheckSql}; no row = the subscription is gone. */
export interface ConnectHelpRecheckRow {
  /** Still a candidate at all: live, with a profile, not imported, customer not blocked, not connected. */
  readonly eligible: boolean;
  /** No decision recorded yet. */
  readonly undecided: boolean;
  /** Paid: the anchor payment is still COMPLETED. Trial: still in «пробный или подарок». */
  readonly stillQualifies: boolean;
  /** The facts the notice may print — the same fields every subscription notice carries. */
  readonly planName: string | null;
  readonly expiresAt: Date | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly profile: string | null;
}

/**
 * The local half of the look before sending, for ONE subscription, read fresh:
 * the cycle's list is minutes old by the time a candidate's turn comes.
 */
export function connectHelpRecheckSql(input: {
  readonly subscriptionId: string;
  readonly kind: ConnectHelpKind;
  readonly anchorTransactionId: string | null;
}): Prisma.Sql {
  const qualifies =
    input.kind === 'trial'
      ? trialBucketSql('s')
      : input.anchorTransactionId === null
        ? Prisma.sql`true`
        : Prisma.sql`EXISTS (SELECT 1 FROM "transactions" "t"
                              WHERE "t"."id" = ${input.anchorTransactionId}
                                AND "t"."status" = 'COMPLETED')`;
  return Prisma.sql`
    SELECT (${eligibleSql()}) AS "eligible",
           ("c"."help_decided_at" IS NULL) AS "undecided",
           (${qualifies}) AS "stillQualifies",
           NULLIF("s"."plan_snapshot"->>'name', '') AS "planName",
           "s"."expires_at" AS "expiresAt",
           "s"."traffic_limit" AS "trafficLimit",
           "s"."device_limit" AS "deviceLimit",
           "s"."remnawave_panel_username" AS "profile"
      FROM "subscriptions" "s"
      JOIN "users" "u" ON "u"."id" = "s"."user_id"
      LEFT JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "s"."id"
     WHERE "s"."id" = ${input.subscriptionId}`;
}

/**
 * The state row, created if the signal never wrote one (a subscription the
 * panel could not read has none, and is exactly the one closed out as
 * unverifiable). Touches nothing on an existing row.
 */
export function ensureStateRowSql(subscriptionId: string, now: Date): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "subscription_connect_states" ("subscription_id", "created_at", "updated_at")
    SELECT "s"."id", ${now}::timestamptz, ${now}::timestamptz
      FROM "subscriptions" "s" WHERE "s"."id" = ${subscriptionId}
    ON CONFLICT ("subscription_id") DO NOTHING`;
}

/**
 * The per-person lock the claim is taken under, so two replicas deciding two
 * subscriptions of one customer at once cannot both find "nothing sent to this
 * person today" and both send. Transaction-scoped: COMMIT or ROLLBACK releases
 * it. `hashtext` is 32-bit, so two customers can rarely share a key — they then
 * wait for each other, which costs a moment and decides nothing. Run it with
 * `$executeRaw`: it returns `void`, which Prisma's query path cannot read.
 */
export function lockPersonSql(userId: string): Prisma.Sql {
  return Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`connect-help:${userId}`})::bigint)`;
}

/**
 * Whether another subscription of the same person was decided within the
 * merge window with help that went out, is going out, or reached them by a
 * broadcast. Skipped, opted-out and merged siblings do not count: nothing was
 * sent for them.
 */
export function mergedSiblingSql(input: {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly now: Date;
}): Prisma.Sql {
  const since = new Date(input.now.getTime() - CONNECT_HELP_MERGE_WINDOW_MS);
  return Prisma.sql`
    SELECT EXISTS (
      SELECT 1
        FROM "subscription_connect_states" "c2"
        JOIN "subscriptions" "s2" ON "s2"."id" = "c2"."subscription_id"
       WHERE "s2"."user_id" = ${input.userId}
         AND "c2"."subscription_id" <> ${input.subscriptionId}
         AND "c2"."help_decided_at" >= ${since}
         AND ("c2"."help_outcome" IS NULL
              OR "c2"."help_outcome" IN (${Prisma.join([...PENDING_HELP_OUTCOMES])}))
    ) AS "merged"`;
}

/**
 * THE CLAIM. One row updated = this sender decided the subscription; zero =
 * somebody else did (another replica, broadcast staging) or it vanished.
 * `outcome` is `NULL` for a ladder about to run, or a final outcome decided at
 * the claim itself (`merged`, `skipped_unverifiable`).
 */
export function claimSql(input: {
  readonly subscriptionId: string;
  readonly kind: ConnectHelpKind;
  readonly anchorAt: Date;
  readonly outcome: HelpOutcome | null;
  readonly now: Date;
}): Prisma.Sql {
  return Prisma.sql`
    UPDATE "subscription_connect_states"
       SET "help_decided_at" = ${input.now}::timestamptz,
           "help_kind" = ${input.kind},
           "help_anchor_at" = ${input.anchorAt}::timestamptz,
           "help_source" = ${CONNECT_HELP_SOURCE_AUTO},
           "help_outcome" = ${input.outcome}::text,
           "help_attempts" = '[]'::jsonb,
           "help_deferrals" = 0,
           "help_event_id" = NULL,
           "updated_at" = ${input.now}::timestamptz
     WHERE "subscription_id" = ${input.subscriptionId}
       AND "help_decided_at" IS NULL`;
}

/** The feed row's id, recorded before any channel runs. Only on the sender's own unfinished claim. */
export function recordEventIdSql(subscriptionId: string, eventId: string, now: Date): Prisma.Sql {
  return Prisma.sql`
    UPDATE "subscription_connect_states"
       SET "help_event_id" = ${eventId}, "updated_at" = ${now}::timestamptz
     WHERE "subscription_id" = ${subscriptionId}
       AND "help_source" = ${CONNECT_HELP_SOURCE_AUTO}
       AND "help_outcome" IS NULL
       AND "help_event_id" IS NULL`;
}

/** A deferred bot step: one more deferral, the attempts appended, the claim left open. */
export function recordDeferralSql(input: {
  readonly subscriptionId: string;
  readonly attempts: readonly unknown[];
  readonly eventId: string | null;
  readonly now: Date;
}): Prisma.Sql {
  return Prisma.sql`
    UPDATE "subscription_connect_states"
       SET "help_deferrals" = "help_deferrals" + 1,
           "help_attempts" = "help_attempts" || ${JSON.stringify(input.attempts)}::jsonb,
           "help_event_id" = COALESCE("help_event_id", ${input.eventId}::text),
           "updated_at" = ${input.now}::timestamptz
     WHERE "subscription_id" = ${input.subscriptionId}
       AND "help_source" = ${CONNECT_HELP_SOURCE_AUTO}
       AND "help_outcome" IS NULL`;
}

/**
 * The final outcome. Guarded on `help_outcome IS NULL`, so of two replicas
 * finishing one resumed ladder only one matches — and only that one emits the
 * event.
 */
export function finalizeSql(input: {
  readonly subscriptionId: string;
  readonly outcome: HelpOutcome;
  readonly attempts: readonly unknown[];
  readonly eventId: string | null;
  readonly now: Date;
}): Prisma.Sql {
  return Prisma.sql`
    UPDATE "subscription_connect_states"
       SET "help_outcome" = ${input.outcome},
           "help_attempts" = "help_attempts" || ${JSON.stringify(input.attempts)}::jsonb,
           "help_event_id" = COALESCE(${input.eventId}::text, "help_event_id"),
           "updated_at" = ${input.now}::timestamptz
     WHERE "subscription_id" = ${input.subscriptionId}
       AND "help_source" = ${CONNECT_HELP_SOURCE_AUTO}
       AND "help_outcome" IS NULL`;
}

/** The log's filter: an outcome, or `in_flight` for a decision whose ladder has not finished. */
export const CONNECT_HELP_LOG_FILTERS = [...HELP_OUTCOMES, 'in_flight'] as const;
export type ConnectHelpLogFilter = (typeof CONNECT_HELP_LOG_FILTERS)[number];

/** One row of the operator's log. */
export interface ConnectHelpLogRow {
  readonly subscriptionId: string;
  readonly decidedAt: Date;
  readonly kind: string | null;
  readonly anchorAt: Date | null;
  readonly source: string | null;
  readonly outcome: string | null;
  readonly attempts: unknown;
  readonly deferrals: number;
  readonly eventId: string | null;
  readonly firstConnectedAt: Date | null;
  readonly userId: string;
  readonly telegramId: bigint | null;
  readonly userName: string | null;
  readonly username: string | null;
  readonly planName: string | null;
  readonly subscriptionStatus: string;
}

/**
 * Newest decision first, keyset-paged on `(help_decided_at, subscription_id)`
 * so the index `subscription_connect_states_help_decided_at_idx` serves it and
 * a page boundary inside one instant neither repeats nor skips a row.
 */
export function connectHelpLogSql(input: {
  readonly before: { readonly decidedAt: Date; readonly subscriptionId: string } | null;
  readonly filter: ConnectHelpLogFilter | null;
  readonly limit: number;
}): Prisma.Sql {
  const seek =
    input.before === null
      ? Prisma.empty
      : Prisma.sql`
       AND ("c"."help_decided_at" < ${input.before.decidedAt}::timestamptz
            OR ("c"."help_decided_at" = ${input.before.decidedAt}::timestamptz
                AND "c"."subscription_id" < ${input.before.subscriptionId}))`;
  const filter =
    input.filter === null
      ? Prisma.empty
      : input.filter === 'in_flight'
        ? Prisma.sql` AND "c"."help_outcome" IS NULL`
        : Prisma.sql` AND "c"."help_outcome" = ${input.filter}`;
  return Prisma.sql`
    SELECT "c"."subscription_id" AS "subscriptionId",
           "c"."help_decided_at" AS "decidedAt",
           "c"."help_kind" AS "kind",
           "c"."help_anchor_at" AS "anchorAt",
           "c"."help_source" AS "source",
           "c"."help_outcome" AS "outcome",
           "c"."help_attempts" AS "attempts",
           "c"."help_deferrals" AS "deferrals",
           "c"."help_event_id" AS "eventId",
           "c"."first_connected_at" AS "firstConnectedAt",
           "s"."user_id" AS "userId",
           "u"."telegram_id" AS "telegramId",
           "u"."name" AS "userName",
           "u"."username" AS "username",
           NULLIF("s"."plan_snapshot"->>'name', '') AS "planName",
           "s"."status"::text AS "subscriptionStatus"
      FROM "subscription_connect_states" "c"
      JOIN "subscriptions" "s" ON "s"."id" = "c"."subscription_id"
      JOIN "users" "u" ON "u"."id" = "s"."user_id"
     WHERE "c"."help_decided_at" IS NOT NULL${seek}${filter}
     ORDER BY "c"."help_decided_at" DESC, "c"."subscription_id" DESC
     LIMIT ${input.limit}`;
}
