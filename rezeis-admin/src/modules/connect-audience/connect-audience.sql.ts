/**
 * «КУПИЛ, НО НЕ ПОДКЛЮЧИЛСЯ» AS AN AUDIENCE OF PEOPLE
 * ═══════════════════════════════════════════════════
 * The statements behind `ConnectAudienceService`, as pure builders so the
 * PostgreSQL spec runs exactly what the service runs. Everything that decides
 * "paid", "trial or gift" and "verified not connected" is WP4a's
 * (`connect-signal/connect-sql.ts`) and is composed here, never restated.
 *
 * ── The two buckets ──────────────────────────────────────────────────────
 *   paid   a live (ACTIVE or LIMITED) subscription with paid money — any
 *          gateway, a partner's balance included; a paid trial included —
 *          CREATED inside the window, linked directly or through a combined
 *          renewal's items (`paidMoneyLinksSql`, which is `paidMoneySql` per
 *          payment, so it is `moneyForSubscriptionSql(s, { since })` with the
 *          payment's own time kept for the anchor below);
 *   trial  a live subscription CREATED inside the window with no paid money
 *          ever and not imported (`trialBucketSql`): free trials, gifts, 0 ₽
 *          promo checkouts, ad bonuses.
 *
 * ── The anchor a read must come after ────────────────────────────────────
 *   paid   the EARLIEST paid money inside the window, at its fulfilment
 *          (`paid_at`): the moment the subscription entered «оплатил за
 *          последние N дней». A successful read after it that still finds no
 *          connection proves "paid and did not connect" for this window. The
 *          newest payment would be stricter than the question: a customer who
 *          paid six days ago and renewed an hour ago, read in between, did pay
 *          and did not connect — making them wait for the next read proves
 *          nothing new. It is also exactly what the design's reference
 *          statement does (§2.4: any in-window payment the read follows).
 *   trial  the grant itself (`subscriptions.created_at`).
 * Plus, from `verifiedNotConnectedSql`: the read is at most 24 hours old, the
 * profile never connected, and it was not reported missing since.
 *
 * ── People, not subscriptions ─────────────────────────────────────────────
 * One row per person. A person is VERIFIED when at least one of their bucket
 * subscriptions is; UNVERIFIED when none is and at least one is not known to
 * have connected — "ещё M не проверены — им не придёт" counts exactly the
 * people the message will not reach. Known-connected subscriptions are in
 * neither. Blocked users are in neither, and neither is anybody who switched
 * «Помощь с подключением» off in the cabinet ({@link connectPersonSql}).
 * `excludeHelped` drops a SUBSCRIPTION that was HELPED ({@link helpedSql}) before
 * the person is counted: help reached them or is on its way, automatically or
 * by an earlier broadcast. A decision that sent nothing (`skipped_…`) is not
 * help, and leaves the subscription in.
 *
 * ── Time ──────────────────────────────────────────────────────────────────
 * Every instant is a BOUND `Date`, never SQL `now()`: see `connect-sql.ts` for
 * why that is what keeps a database whose time zone is not UTC consistent.
 */
import { Prisma } from '@prisma/client';

import {
  PENDING_HELP_OUTCOMES,
  paidMoneyLinksSql,
  trialBucketSql,
  verifiedNotConnectedSql,
  type HelpOutcome,
} from '../connect-signal/connect-sql';

/**
 * The outcomes after which a subscription counts as HELPED — an ALLOWLIST.
 *
 *   bot | push | email | banner | broadcast   help reached the customer
 *                                             (`PENDING_HELP_OUTCOMES`);
 *   merged                                    it went out for a sibling
 *                                             subscription of the same person;
 *   opted_out                                 the customer said no.
 *
 * Every other outcome — `skipped_unverifiable`, `skipped_template_off`, and
 * any terminal value added later — means nothing was sent, and is NOT helped
 * by construction: a new value lands on that side without anybody having to
 * remember this list. A ladder still in flight (decided, no outcome yet) is
 * helped too; see {@link helpedSql}.
 */
export const HELPED_OUTCOMES = [...PENDING_HELP_OUTCOMES, 'merged', 'opted_out'] as const satisfies readonly HelpOutcome[];

/**
 * Whether the state row `alias` is HELPED: its outcome is one of
 * {@link HELPED_OUTCOMES}, or it was decided and has no outcome yet (the
 * automatic ladder is on its way). TRUE or FALSE, never NULL — an absent row
 * (every column NULL) is not helped.
 *
 * What «Не слать тем, кому уже помогли» leaves out, and what the broadcast's
 * once-marker never touches: a helped row is somebody else's decision, and a
 * row in flight is the automatic sender's until it lands.
 */
export function helpedSql(alias: 'c' | 'st'): Prisma.Sql {
  const outcome = Prisma.raw(`"${alias}"."help_outcome"`);
  const decidedAt = Prisma.raw(`"${alias}"."help_decided_at"`);
  return Prisma.sql`COALESCE((${outcome} IN (${Prisma.join([...HELPED_OUTCOMES])})
      OR (${decidedAt} IS NOT NULL AND ${outcome} IS NULL)), false)`;
}

/**
 * Who a «не подключился» list may name at all, on the users row `"u"`: not
 * blocked, and not somebody who switched «Помощь с подключением» off in the
 * cabinet — `notification_prefs.connect_help` is JSON `false`, exactly what
 * `connectHelpOptedOut` reads. A missing key, `true`, a string, NULL prefs or
 * prefs that are not an object all leave the person in, as they do there.
 *
 * One predicate for every reader — the broadcast preview, its counts, its
 * staging and the hint audiences — so none of them can name a person the
 * others would not.
 */
export function connectPersonSql(): Prisma.Sql {
  return Prisma.sql`"u"."is_blocked" = false
         AND ("u"."notification_prefs" -> 'connect_help') IS DISTINCT FROM 'false'::jsonb`;
}

/** «Оплатил и не подключился» / «Пробный период или подарок — не подключился». */
export const CONNECT_BUCKETS = ['paid', 'trial'] as const;
export type ConnectBucket = (typeof CONNECT_BUCKETS)[number];

/** Both ends inclusive. The payment's creation (paid) or the grant (trial) must fall in it. */
export interface ConnectAudienceWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * The bucket's subscriptions with their anchors, as a derived table of
 * `(subscription_id, user_id, anchor_at)`.
 *
 * Paid starts from the money: the window bounds `created_at`, which
 * `transactions_status_created_at_idx` serves in both arms of
 * `paidMoneyLinksSql`, and the subscription is joined by its key. Trial starts
 * from `subscriptions_created_status_idx` (`created_at`, `status`), and the
 * no-money test is two index probes per row.
 */
export function connectBucketSql(bucket: ConnectBucket, window: ConnectAudienceWindow): Prisma.Sql {
  if (bucket === 'paid') {
    return Prisma.sql`(SELECT "s"."id" AS "subscription_id",
            "s"."user_id" AS "user_id",
            min("p"."paid_at") AS "anchor_at"
       FROM ${paidMoneyLinksSql()} "p"
       JOIN "subscriptions" "s" ON "s"."id" = "p"."subscription_id"
      WHERE "p"."created_at" >= ${window.from}::timestamptz
        AND "p"."created_at" <= ${window.to}::timestamptz
        AND "s"."status" IN ('ACTIVE', 'LIMITED')
      GROUP BY "s"."id", "s"."user_id")`;
  }
  return Prisma.sql`(SELECT "s"."id" AS "subscription_id",
          "s"."user_id" AS "user_id",
          "s"."created_at" AS "anchor_at"
     FROM "subscriptions" "s"
    WHERE "s"."created_at" >= ${window.from}::timestamptz
      AND "s"."created_at" <= ${window.to}::timestamptz
      AND "s"."status" IN ('ACTIVE', 'LIMITED')
      AND ${trialBucketSql('s')})`;
}

/** One row of {@link connectAudienceSql}: a verified person, or (last) the two counts. */
export interface ConnectAudienceRow {
  readonly userId: string | null;
  readonly ord: number | null;
  readonly verified: number | null;
  readonly unverified: number | null;
}

/**
 * The audience in ONE statement: the verified people, oldest anchor first, at
 * most `idLimit` of them (`0` = counts only), then a final row with the two
 * person counts. One statement so the preview pays for the bucket once; the
 * people are materialised once and read twice.
 */
export function connectAudienceSql(input: {
  readonly bucket: ConnectBucket;
  readonly window: ConnectAudienceWindow;
  readonly now: Date;
  readonly excludeHelped: boolean;
  readonly idLimit: number;
}): Prisma.Sql {
  const helped = input.excludeHelped ? Prisma.sql`AND NOT ${helpedSql('c')}` : Prisma.empty;
  return Prisma.sql`
    WITH "wp4b_subs" AS MATERIALIZED (
      SELECT "b"."user_id" AS "user_id",
             "b"."anchor_at" AS "anchor_at",
             ${verifiedNotConnectedSql('c', Prisma.sql`"b"."anchor_at"`, input.now)} AS "verified"
        FROM ${connectBucketSql(input.bucket, input.window)} "b"
        JOIN "users" "u" ON "u"."id" = "b"."user_id" AND ${connectPersonSql()}
        LEFT JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "b"."subscription_id"
       WHERE "c"."first_connected_at" IS NULL
         ${helped}
    ), "wp4b_people" AS MATERIALIZED (
      SELECT "user_id",
             bool_or("verified") AS "verified",
             min("anchor_at") FILTER (WHERE "verified") AS "first_anchor"
        FROM "wp4b_subs"
       GROUP BY "user_id"
    )
    SELECT "v"."user_id" AS "userId", "v"."ord" AS "ord", NULL::int AS "verified", NULL::int AS "unverified"
      FROM (SELECT "user_id",
                   (row_number() OVER (ORDER BY "first_anchor" ASC, "user_id" ASC))::int AS "ord"
              FROM "wp4b_people"
             WHERE "verified"
             ORDER BY "first_anchor" ASC, "user_id" ASC
             LIMIT ${input.idLimit}) "v"
    UNION ALL
    SELECT NULL, NULL,
           (count(*) FILTER (WHERE "verified"))::int,
           (count(*) FILTER (WHERE NOT "verified"))::int
      FROM "wp4b_people"
    ORDER BY "ord" ASC NULLS LAST`;
}

/** `help_source` of the subscriptions one broadcast marked. */
export function broadcastHelpSource(broadcastId: string): string {
  return `broadcast:${broadcastId}`;
}

/**
 * The once-marker for a staged broadcast: every subscription of `userIds`
 * (the broadcast's recipients) that is in the bucket, VERIFIED not connected
 * right now and not HELPED ({@link helpedSql}) gets `help_decided_at`,
 * `help_kind`, `help_anchor_at`, `help_source = 'broadcast:<id>'` and
 * `help_outcome = 'broadcast'`, with the ladder's bookkeeping cleared the way
 * the automatic claim clears it.
 *
 * Two kinds of row qualify: one nobody decided yet, and one the automatic
 * sender decided WITHOUT sending anything (`skipped_…`) — this broadcast is
 * then the first help that reaches the customer, and the row says so. A
 * helped row (help went out, merged, opted out, another broadcast) and a row
 * in flight (claimed, no outcome yet — the automatic ladder may be sending
 * right now) are never touched, so a second staging, the automatic sender and
 * this never overwrite one another. The automatic sender never claims a
 * decided row again, so overwriting a `skipped_…` one races nothing.
 *
 * The rows are locked in subscription order first (`FOR UPDATE`, ordered), so
 * this multi-row write cannot deadlock against the signal's writers, which
 * lock in the same order. A row the sender claims while this waits is
 * re-checked after the wait and skipped. The person must still be one the
 * lists may name ({@link connectPersonSql}), so nobody who switched the help
 * off in the seconds since the list was made is marked. Returns the ids marked.
 */
export function markHelpedByBroadcastSql(input: {
  readonly broadcastId: string;
  readonly bucket: ConnectBucket;
  readonly window: ConnectAudienceWindow;
  readonly now: Date;
  readonly userIds: readonly string[];
}): Prisma.Sql {
  const source = broadcastHelpSource(input.broadcastId);
  return Prisma.sql`
    WITH "wp4b_targets" AS MATERIALIZED (
      SELECT "c"."subscription_id" AS "subscription_id", "b"."anchor_at" AS "anchor_at"
        FROM ${connectBucketSql(input.bucket, input.window)} "b"
        JOIN "users" "u" ON "u"."id" = "b"."user_id" AND ${connectPersonSql()}
        JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "b"."subscription_id"
       WHERE "b"."user_id" = ANY(${[...input.userIds]}::text[])
         AND ${verifiedNotConnectedSql('c', Prisma.sql`"b"."anchor_at"`, input.now)}
         AND NOT ${helpedSql('c')}
       ORDER BY "c"."subscription_id"
         FOR UPDATE OF "c"
    )
    UPDATE "subscription_connect_states" AS "st"
       SET "help_decided_at" = ${input.now}::timestamptz,
           "help_kind" = ${input.bucket}::text,
           "help_anchor_at" = "t"."anchor_at",
           "help_source" = ${source}::text,
           "help_outcome" = 'broadcast',
           "help_attempts" = '[]'::jsonb,
           "help_deferrals" = 0,
           "help_event_id" = NULL,
           "updated_at" = ${input.now}::timestamptz
      FROM "wp4b_targets" "t"
     WHERE "st"."subscription_id" = "t"."subscription_id"
       AND NOT ${helpedSql('st')}
    RETURNING "st"."subscription_id" AS "subscriptionId"`;
}

/**
 * Of `userIds` — the broadcast's recipients as the audience was resolved,
 * seconds ago and before the claim — the people this broadcast may still
 * write to, read INSIDE staging's transaction, after the marker:
 *
 *   • still one the lists may name ({@link connectPersonSql});
 *   • with a bucket subscription still VERIFIED not connected — a connection
 *     recorded in between takes them out;
 *   • with `excludeHelped`, that subscription must also carry THIS broadcast's
 *     marker: marked just now, or by an earlier staging of the same broadcast,
 *     so a retried staging finds the same people. A subscription the
 *     automatic help claimed in between carries the sender's marker instead,
 *     and its person is not written to twice.
 *
 * One row per person, in no particular order; the caller keeps its own.
 */
export function stagedRecipientsSql(input: {
  readonly broadcastId: string;
  readonly bucket: ConnectBucket;
  readonly window: ConnectAudienceWindow;
  readonly now: Date;
  readonly userIds: readonly string[];
  readonly excludeHelped: boolean;
}): Prisma.Sql {
  const ours = input.excludeHelped
    ? Prisma.sql`AND "c"."help_source" = ${broadcastHelpSource(input.broadcastId)}::text`
    : Prisma.empty;
  return Prisma.sql`
    SELECT DISTINCT "b"."user_id" AS "userId"
      FROM ${connectBucketSql(input.bucket, input.window)} "b"
      JOIN "users" "u" ON "u"."id" = "b"."user_id" AND ${connectPersonSql()}
      JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "b"."subscription_id"
     WHERE "b"."user_id" = ANY(${[...input.userIds]}::text[])
       AND ${verifiedNotConnectedSql('c', Prisma.sql`"b"."anchor_at"`, input.now)}
       ${ours}`;
}
