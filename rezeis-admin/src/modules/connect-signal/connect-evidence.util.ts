/**
 * EVERY WRITE OF THE CONNECTION SIGNAL GOES THROUGH THIS FILE
 * ═══════════════════════════════════════════════════════════
 * Whether a subscription's VPN profile ever connected is learned from three
 * places, and all three write through the functions below:
 *
 *   webhook  every `user.*` event whose `data` carries the traffic block
 *            (`RemnawaveWebhookService`), plus `user.first_connected` and the
 *            `user.not_connected` confirmation;
 *   cabinet  the profile read the dashboard already makes for every card
 *            (`InternalUserService`) — no extra request, at most one write per
 *            subscription per ten minutes;
 *   probe    a bounded worker job for the subscriptions nobody else read
 *            (`ConnectSignalProbeService`).
 *
 * Plain functions taking the Prisma client, in the style of
 * `settings-row-write.util.ts`, so the webhook service and the internal-user
 * service call them without importing a Nest module — no module cycle.
 *
 * ── Idempotent, order-independent, replay-safe ────────────────────────────
 *   first_connected_at = LEAST(stored, new)   — only ever lowered, never NULLed
 *   checked_at         = GREATEST(stored, new) — only ever moves forward
 * each in ONE `INSERT … ON CONFLICT DO UPDATE`, so duplicate webhooks, a
 * re-delivery, two writers racing and events arriving out of order all leave
 * the same row behind.
 *
 * ── Fan-out ───────────────────────────────────────────────────────────────
 * `remnawave_id` is not unique and duplicate rows of one profile exist in
 * production, so a write lands on EVERY non-deleted subscription the caller's
 * `where` names — the caller passes `panelIdentityWhere(identity)`, the one
 * definition of "which rows does this panel identity name", rather than this
 * file restating it. Rows are locked in id order so two writers fanning out
 * over the same pair cannot deadlock each other.
 *
 * ── Time ──────────────────────────────────────────────────────────────────
 * Every timestamp is a BOUND `Date` — `created_at` and `updated_at` included,
 * never the column default and never SQL `now()`. See `connect-sql.ts` for why
 * that is what keeps a database whose time zone is not UTC consistent.
 */
import { Prisma, SubscriptionStatus } from '@prisma/client';

import type { PanelUserTraffic } from '../remnawave/services/remnawave-api.service';
import { PENDING_HELP_OUTCOMES, pendingHelpSql, type ConnectSource } from './connect-sql';

export type { ConnectSource } from './connect-sql';

/**
 * What one look at a profile says about ever having connected.
 *
 * `unknown` is its own answer and never a softer "not connected": a missing or
 * unreadable traffic block, a panel that did not answer, a payload with no
 * block. Nothing downstream may message a customer on it.
 */
export type ConnectEvidence =
  | { readonly kind: 'connected'; readonly at: Date }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'unknown' };

export const UNKNOWN_EVIDENCE: ConnectEvidence = { kind: 'unknown' };

function instantOf(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * THE EVIDENCE RULE — one pure function, used by every writer.
 *
 *   connected  ⇔ firstConnectedAt ≠ null OR onlineAt ≠ null
 *                OR lifetimeUsedTrafficBytes > 0 OR usedTrafficBytes > 0
 *   at         = firstConnectedAt ?? onlineAt ?? now, never later than now
 *
 * "Not connected" only when the block is PRESENT and all four are empty. A
 * missing block (`null` / `undefined` — see `decodePanelUserTraffic`) is
 * `unknown`. `onlineAt` is in the rule because Remnawave's own "not connected"
 * query requires it to be NULL as well; `usedTrafficBytes` alone is not enough
 * because it resets with every monthly traffic reset.
 */
export function connectEvidenceOf(
  userTraffic: PanelUserTraffic | null | undefined,
  now: Date,
): ConnectEvidence {
  if (userTraffic === null || userTraffic === undefined) return UNKNOWN_EVIDENCE;
  const firstConnectedAt = instantOf(userTraffic.firstConnectedAt);
  const onlineAt = instantOf(userTraffic.onlineAt);
  const lifetime = userTraffic.lifetimeUsedTrafficBytes ?? 0;
  const used = userTraffic.usedTrafficBytes ?? 0;
  if (firstConnectedAt === null && onlineAt === null && !(lifetime > 0) && !(used > 0)) {
    return { kind: 'not_connected' };
  }
  const at = firstConnectedAt ?? onlineAt ?? now;
  // A panel whose clock runs ahead must not put a connection in the future.
  return { kind: 'connected', at: at.getTime() > now.getTime() ? now : at };
}

/** What the writers need of the Prisma client — `PrismaService` or a transaction. */
export type ConnectSignalClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'subscription' | 'user'>;

/** Which subscriptions a write is about — normally `panelIdentityWhere(identity)`. */
export type ConnectTarget = Prisma.SubscriptionWhereInput;

/** The ids of the non-deleted subscriptions `target` names, in id order. */
async function targetIds(prisma: ConnectSignalClient, target: ConnectTarget): Promise<string[]> {
  const rows = await prisma.subscription.findMany({
    where: { AND: [target, { status: { not: SubscriptionStatus.DELETED } }] },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}

interface WrittenRow {
  readonly subscription_id: string;
}

/**
 * Evidence that the profile CONNECTED, on every row `subscriptions` names.
 *
 * `first_connected_at` is lowered to `at` (or set); `connected_source` names
 * whoever proved the earliest time. `checkedAt` is the read's own time when it
 * carried a traffic block — it also counts as a successful read (verification
 * clock forward, failures reset, a stale "missing" cleared); pass `null` for
 * evidence that came without a block (`user.first_connected` alone).
 *
 * Returns the ids written.
 */
export async function recordConnectEvidence(
  prisma: ConnectSignalClient,
  input: {
    readonly subscriptions: ConnectTarget;
    readonly at: Date;
    readonly source: ConnectSource;
    readonly checkedAt: Date | null;
    readonly now?: Date;
  },
): Promise<readonly string[]> {
  const ids = await targetIds(prisma, input.subscriptions);
  if (ids.length === 0) return [];
  const now = input.now ?? new Date();
  const rows = await prisma.$queryRaw<WrittenRow[]>(Prisma.sql`
    INSERT INTO "subscription_connect_states" AS "st"
      ("subscription_id", "first_connected_at", "connected_source", "checked_at", "check_failures",
       "created_at", "updated_at")
    SELECT "s"."id", ${input.at}::timestamptz, ${input.source}::text, ${input.checkedAt}::timestamptz, 0,
           ${now}::timestamptz, ${now}::timestamptz
      FROM "subscriptions" "s"
     WHERE "s"."id" IN (${Prisma.join(ids)})
     ORDER BY "s"."id"
    ON CONFLICT ("subscription_id") DO UPDATE SET
      "first_connected_at" = LEAST(COALESCE("st"."first_connected_at", EXCLUDED."first_connected_at"),
                                   EXCLUDED."first_connected_at"),
      "connected_source" = CASE
        WHEN "st"."first_connected_at" IS NULL
          OR EXCLUDED."first_connected_at" < "st"."first_connected_at"
        THEN EXCLUDED."connected_source"
        ELSE "st"."connected_source" END,
      "checked_at" = CASE
        WHEN EXCLUDED."checked_at" IS NULL THEN "st"."checked_at"
        ELSE GREATEST(COALESCE("st"."checked_at", EXCLUDED."checked_at"), EXCLUDED."checked_at") END,
      "check_failures" = CASE WHEN EXCLUDED."checked_at" IS NULL THEN "st"."check_failures" ELSE 0 END,
      "profile_missing_at" = CASE
        WHEN EXCLUDED."checked_at" IS NOT NULL AND "st"."profile_missing_at" <= EXCLUDED."checked_at" THEN NULL
        ELSE "st"."profile_missing_at" END,
      "updated_at" = EXCLUDED."updated_at"
    RETURNING "st"."subscription_id"
  `);
  return rows.map((row) => row.subscription_id);
}

/**
 * A successful read found the profile NOT connected: the verification clock
 * moves forward to `checkedAt`, failures reset, a stale "missing" is cleared.
 *
 * Only on rows not already known to have connected — a row that has evidence
 * keeps it untouched, which is also exactly what `user.not_connected` (a
 * confirmation, never a source) must do. A subscription with no state row yet
 * gets one.
 *
 * Returns the ids written.
 */
export async function recordCheck(
  prisma: ConnectSignalClient,
  input: {
    readonly subscriptions: ConnectTarget;
    readonly checkedAt: Date;
    readonly now?: Date;
  },
): Promise<readonly string[]> {
  const ids = await targetIds(prisma, input.subscriptions);
  if (ids.length === 0) return [];
  const now = input.now ?? new Date();
  const rows = await prisma.$queryRaw<WrittenRow[]>(Prisma.sql`
    INSERT INTO "subscription_connect_states" AS "st"
      ("subscription_id", "checked_at", "check_failures", "created_at", "updated_at")
    SELECT "s"."id", ${input.checkedAt}::timestamptz, 0, ${now}::timestamptz, ${now}::timestamptz
      FROM "subscriptions" "s"
     WHERE "s"."id" IN (${Prisma.join(ids)})
     ORDER BY "s"."id"
    ON CONFLICT ("subscription_id") DO UPDATE SET
      "checked_at" = GREATEST(COALESCE("st"."checked_at", EXCLUDED."checked_at"), EXCLUDED."checked_at"),
      "check_failures" = 0,
      "profile_missing_at" = CASE
        WHEN "st"."profile_missing_at" <= EXCLUDED."checked_at" THEN NULL
        ELSE "st"."profile_missing_at" END,
      "updated_at" = EXCLUDED."updated_at"
    WHERE "st"."first_connected_at" IS NULL
    RETURNING "st"."subscription_id"
  `);
  return rows.map((row) => row.subscription_id);
}

/**
 * The probe could not read this profile (the panel did not answer, answered
 * something we cannot decode, or the profile cannot be named on this panel).
 * Counts toward the backoff and stamps nothing else: a failed read verifies
 * nothing, in either direction.
 */
export async function recordProbeFailure(
  prisma: Pick<Prisma.TransactionClient, '$executeRaw'>,
  subscriptionId: string,
  now: Date,
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_connect_states" AS "st"
      ("subscription_id", "check_failures", "created_at", "updated_at")
    SELECT "s"."id", 1, ${now}::timestamptz, ${now}::timestamptz
      FROM "subscriptions" "s" WHERE "s"."id" = ${subscriptionId}
    ON CONFLICT ("subscription_id") DO UPDATE SET
      "check_failures" = "st"."check_failures" + 1,
      "updated_at" = EXCLUDED."updated_at"
  `);
}

/**
 * The panel itself said this profile does not exist (a 404 carrying its own
 * USER_NOT_FOUND). Recorded, and never read as "not connected". The panel did
 * answer, so the failure count resets.
 */
export async function recordProfileMissing(
  prisma: Pick<Prisma.TransactionClient, '$executeRaw'>,
  subscriptionId: string,
  now: Date,
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_connect_states" AS "st"
      ("subscription_id", "profile_missing_at", "check_failures", "created_at", "updated_at")
    SELECT "s"."id", ${now}::timestamptz, 0, ${now}::timestamptz, ${now}::timestamptz
      FROM "subscriptions" "s" WHERE "s"."id" = ${subscriptionId}
    ON CONFLICT ("subscription_id") DO UPDATE SET
      "profile_missing_at" = GREATEST(COALESCE("st"."profile_missing_at", EXCLUDED."profile_missing_at"),
                                      EXCLUDED."profile_missing_at"),
      "check_failures" = 0,
      "updated_at" = EXCLUDED."updated_at"
  `);
}

/** How old connection evidence may be and still announce a FIRST connection. */
export const FIRST_TRAFFIC_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Fills `User.firstTrafficAt` with `at` when it is still NULL — the claim the
 * webhook always made, now fed the evidence's own time instead of the moment
 * the panel happened to hear about it. One conditional write, so exactly one
 * writer wins however many race. Answers whether THIS call won.
 */
export async function claimFirstTraffic(
  prisma: Pick<ConnectSignalClient, 'user'>,
  userId: string,
  at: Date,
): Promise<boolean> {
  const claimed = await prisma.user.updateMany({
    where: { id: userId, firstTrafficAt: null },
    data: { firstTrafficAt: at },
  });
  return claimed.count === 1;
}

/**
 * Whether the claim winner should emit `user.first_traffic`: only for evidence
 * at most a day old. A customer who connected months ago and is only now
 * heard about — an install that just enabled webhooks, the probe's first pass
 * over the backlog — gets the column filled and no card, no pop-up.
 */
export function firstTrafficEventDue(at: Date, now: Date): boolean {
  return now.getTime() - at.getTime() <= FIRST_TRAFFIC_EVENT_MAX_AGE_MS;
}

/**
 * Whether this person has a LIVE subscription (ACTIVE or LIMITED) on which help
 * was given and which has still never connected — what the pop-up guard asks
 * before showing «Не получилось подключиться?».
 */
export async function hasPendingConnectHelp(
  prisma: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ readonly pending: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
        FROM "subscriptions" "s"
        JOIN "subscription_connect_states" "c" ON "c"."subscription_id" = "s"."id"
       WHERE "s"."user_id" = ${userId}
         AND "s"."status" IN ('ACTIVE', 'LIMITED')
         AND ${pendingHelpSql('c')}
    ) AS "pending"
  `);
  return rows[0]?.pending === true;
}

/**
 * × on the cabinet banner: remembered on the subscription so it stays hidden on
 * every device. Idempotent — the first dismissal's time is kept.
 */
export async function dismissConnectHelpBanner(
  prisma: Pick<Prisma.TransactionClient, '$executeRaw'>,
  subscriptionId: string,
  now: Date,
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscription_connect_states" AS "st"
      ("subscription_id", "banner_dismissed_at", "created_at", "updated_at")
    SELECT "s"."id", ${now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz
      FROM "subscriptions" "s" WHERE "s"."id" = ${subscriptionId}
    ON CONFLICT ("subscription_id") DO UPDATE SET
      "banner_dismissed_at" = COALESCE("st"."banner_dismissed_at", EXCLUDED."banner_dismissed_at"),
      "updated_at" = EXCLUDED."updated_at"
  `);
}

/** The part of a state row the cabinet payload is computed from. */
export interface ConnectHelpStateView {
  readonly firstConnectedAt: Date | null;
  readonly helpOutcome: string | null;
  readonly bannerDismissedAt: Date | null;
}

/** The customer switched «Помощь с подключением» off in the cabinet. */
export function connectHelpOptedOut(notificationPrefs: unknown): boolean {
  if (notificationPrefs === null || typeof notificationPrefs !== 'object' || Array.isArray(notificationPrefs)) {
    return false;
  }
  return (notificationPrefs as Record<string, unknown>)['connect_help'] === false;
}

/**
 * `connectHelp` on one subscription of the cabinet payload:
 *
 *   pending = help was GIVEN (bot | push | email | banner | broadcast), the
 *             subscription is live, and nothing — neither the state row nor the
 *             read this very request made — has seen it connect;
 *   banner  = pending AND the ladder ended at the banner AND not dismissed AND
 *             the customer did not opt out.
 *
 * `null` whenever help is not pending — the cabinet reads the field's absence,
 * `null`, and `{ pending: false }` alike, and `null` is also what a panel
 * without the feature sends.
 */
export function connectHelpFlags(input: {
  readonly state: ConnectHelpStateView | null;
  readonly connectedNow: boolean;
  readonly status: SubscriptionStatus;
  readonly optedOut: boolean;
}): { readonly pending: true; readonly banner: boolean } | null {
  const { state } = input;
  if (state === null) return null;
  if (input.status !== SubscriptionStatus.ACTIVE && input.status !== SubscriptionStatus.LIMITED) return null;
  if (input.connectedNow || state.firstConnectedAt !== null) return null;
  if (state.helpOutcome === null || !(PENDING_HELP_OUTCOMES as readonly string[]).includes(state.helpOutcome)) {
    return null;
  }
  return {
    pending: true,
    banner: state.helpOutcome === 'banner' && state.bannerDismissedAt === null && !input.optedOut,
  };
}
