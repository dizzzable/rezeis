/**
 * Whether a customer is at the screen right now, stepped away, or gone.
 *
 * WHAT THE SIGNAL ACTUALLY IS. `User.lastSeenAt` is the last activity the
 * cabinet reported for that person — it moves while they are using the app and
 * stops when they close it. It is NOT a heartbeat: nothing pings on an interval
 * while a tab sits idle, so a stale value can mean "left" or "reading". That is
 * exactly why there is a middle band rather than an online/offline pair.
 *
 * WHY THE THRESHOLDS ARE WHAT THEY ARE. They are not new. The user card in the
 * panel has drawn a green dot under five minutes and an amber one under thirty
 * since long before this file existed, and operators read those dots daily —
 * so these constants restate that behaviour rather than inventing one, and the
 * card now reads THIS answer instead of recomputing it. A second definition
 * over there is exactly how the same person ends up online on one screen and
 * away on another.
 *
 * A user who has never opened the cabinet has no `lastSeenAt` at all. They are
 * `offline`, and deliberately so: `unknown` as a fourth bucket would put every
 * Telegram-only customer in a category an operator has no use for.
 */

/** Activity newer than this reads as "at the screen". */
export const PRESENCE_ONLINE_MS = 5 * 60_000;
/** Activity newer than this, but not `online`, reads as "stepped away". */
export const PRESENCE_AWAY_MS = 30 * 60_000;

export const USER_PRESENCE_VALUES = ['online', 'away', 'offline'] as const;
export type UserPresence = (typeof USER_PRESENCE_VALUES)[number];

export function isUserPresence(value: unknown): value is UserPresence {
  return (
    typeof value === 'string' && (USER_PRESENCE_VALUES as readonly string[]).includes(value)
  );
}

/** Which bucket a stored `lastSeenAt` falls into, as of `now`. */
export function resolveUserPresence(
  lastSeenAt: Date | null | undefined,
  now: Date = new Date(),
): UserPresence {
  if (!lastSeenAt) return 'offline';
  const elapsed = now.getTime() - lastSeenAt.getTime();
  // A clock skew between the reporter and this process can put the timestamp in
  // the future. Treat that as "just now" rather than letting a negative elapsed
  // fall through to `offline`, which is the one answer it certainly is not.
  if (elapsed < PRESENCE_ONLINE_MS) return 'online';
  if (elapsed < PRESENCE_AWAY_MS) return 'away';
  return 'offline';
}

/**
 * The `lastSeenAt` condition that selects one bucket.
 *
 * Returned as a Prisma filter fragment rather than applied here, so the caller
 * composes it with everything else in one query instead of filtering a page in
 * memory — which would silently return fewer rows than the page size asked for.
 */
export function presenceFilter(
  presence: UserPresence,
  now: Date = new Date(),
): { lastSeenAt: { gt?: Date; lte?: Date } } | { OR: unknown[] } {
  const onlineFrom = new Date(now.getTime() - PRESENCE_ONLINE_MS);
  const awayFrom = new Date(now.getTime() - PRESENCE_AWAY_MS);
  // Strictly newer than the cutoff, matching `resolveUserPresence` exactly.
  // The first draft used `gte` here against a `<` there, so a row sitting on
  // the boundary was labelled `away` and returned by the `online` filter — a
  // list of people the labels contradict, which reads as the labels being
  // wrong rather than the query.
  if (presence === 'online') return { lastSeenAt: { gt: onlineFrom } };
  if (presence === 'away') return { lastSeenAt: { gt: awayFrom, lte: onlineFrom } };
  // `offline` has to include the users who have never been seen at all, and
  // `lastSeenAt: { lte: … }` alone drops every NULL — which is most of a
  // Telegram-first install.
  return { OR: [{ lastSeenAt: { lte: awayFrom } }, { lastSeenAt: null }] };
}
