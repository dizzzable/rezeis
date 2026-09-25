import { Prisma } from '@prisma/client';

/**
 * TWO FACTS ABOUT A REMNAWAVE PROFILE THAT THE PANEL KEEPS ON THE SUBSCRIPTION
 * ════════════════════════════════════════════════════════════════════════════
 * `subscriptions.remnawave_profile_created_at` and
 * `subscriptions.remnawave_last_traffic_reset_at` (migration
 * `20260925120000_subscription_remnawave_reset_facts`). Stage 4 — traffic
 * add-ons that last until Remnawave's own traffic reset — needs both, and only
 * Remnawave knows either:
 *
 *  - `createdAt` is MONTH_ROLLING's anchor: Remnawave resets such a profile on
 *    the UTC day of month of it (`reset-cycle-policy.ts`). Our CREATE never
 *    sends it, so it is the moment the CREATE reached Remnawave, or a donor
 *    bot's date for an imported profile.
 *  - `lastTrafficResetAt` is when Remnawave last zeroed the counter. A
 *    scheduled reset sends NO webhook (only `user.enabled`, and only for
 *    LIMITED users), so this is learnt from whatever answer next carries the
 *    user; the boundary sweep reads it to confirm a reset before it takes a
 *    «до сброса» add-on off.
 *
 * STAMPED FROM EVERY FULL USER THE PANEL SEES, WHATEVER THE SUBSCRIPTION'S
 * STATUS: the CREATE and PATCH answers and the traffic-reset answer in profile
 * sync, every user webhook, ↻ and the Remnawave importer. Until 25.09.2026 the
 * rolling anchor was stamped only while the subscription was ACTIVE, and a
 * LIMITED customer — the one who wants traffic — could be left with none.
 *
 * THE TWO RULES, both enforced in the one statement below so that no caller
 * can get them wrong and no race can undo them:
 *  - a value is never overwritten with `null`: an answer that did not carry a
 *    field says nothing about it;
 *  - `lastTrafficResetAt` only moves FORWARD. Events arrive late and out of
 *    order; one carrying an older reset must not take the column back, or a
 *    confirmed reset would read as unconfirmed again. `createdAt` is not
 *    forward-only: it follows the profile, and a profile re-provisioned after
 *    Remnawave lost the old one brings its own.
 */
export interface RemnawaveProfileFacts {
  /** The profile's `createdAt`; `null` when the answer did not carry a readable one. */
  readonly createdAt: Date | null;
  /** The profile's `lastTrafficResetAt`; `null` when the answer did not carry one (never reset, or absent). */
  readonly lastTrafficResetAt: Date | null;
}

export const NO_REMNAWAVE_PROFILE_FACTS: RemnawaveProfileFacts = Object.freeze({
  createdAt: null,
  lastTrafficResetAt: null,
});

/** An instant off the wire: an ISO string (what the client hands over) or a `Date` (what older doubles hand over). */
function readInstant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/**
 * Both facts off a Remnawave user as it arrived — a webhook's `data`, a
 * create/update/reset answer, a decoded row. Nothing validates those bodies,
 * so every field is read as unknown: a missing or unreadable one is `null`,
 * never `Invalid Date` (which, written as an anchor, would silently move a
 * customer's reset day).
 */
export function readRemnawaveProfileFacts(user: unknown): RemnawaveProfileFacts {
  if (user === null || typeof user !== 'object' || Array.isArray(user)) return NO_REMNAWAVE_PROFILE_FACTS;
  const record = user as Record<string, unknown>;
  return {
    createdAt: readInstant(record['createdAt']),
    lastTrafficResetAt: readInstant(record['lastTrafficResetAt']),
  };
}

/** A client that can run the stamp: `PrismaService` or a transaction. */
export type RemnawaveProfileFactsClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * Stamps `facts` onto the subscriptions `subscriptionIds`, under the two rules
 * above, in ONE statement. Answers how many rows moved.
 *
 * A row is written only when a value actually moves, so a repeated answer — a
 * webhook for every change, a PATCH on every push — costs a scan of one row
 * and no write, no lock and no `updated_at`. `GREATEST` ignores NULL on either
 * side, which is the whole of both rules for the reset column; `COALESCE`
 * keeps the stored anchor when the answer has none. Under READ COMMITTED
 * PostgreSQL re-evaluates both the `SET` and the `WHERE` against the row a
 * concurrent writer just committed, so two answers racing each other land the
 * later reset whatever order they commit in.
 */
export async function stampRemnawaveProfileFacts(
  client: RemnawaveProfileFactsClient,
  subscriptionIds: readonly string[],
  facts: RemnawaveProfileFacts,
): Promise<number> {
  if (subscriptionIds.length === 0) return 0;
  if (facts.createdAt === null && facts.lastTrafficResetAt === null) return 0;
  const createdAt = Prisma.sql`COALESCE(${facts.createdAt}::timestamptz, "remnawave_profile_created_at")`;
  const lastReset = Prisma.sql`GREATEST("remnawave_last_traffic_reset_at", ${facts.lastTrafficResetAt}::timestamptz)`;
  return client.$executeRaw(Prisma.sql`
    UPDATE "subscriptions"
       SET "remnawave_profile_created_at" = ${createdAt},
           "remnawave_last_traffic_reset_at" = ${lastReset}
     WHERE "id" = ANY(${[...subscriptionIds]}::text[])
       AND (
         "remnawave_profile_created_at" IS DISTINCT FROM ${createdAt}
         OR "remnawave_last_traffic_reset_at" IS DISTINCT FROM ${lastReset}
       )
  `);
}
