/**
 * The status dot: one set of rules for every screen that draws one.
 *
 * WHY THIS FILE EXISTS. There were three. `user-detail-panel` computed presence
 * in the browser, `users-page` computed it again a few hundred lines away, and
 * the support picker started reading the answer the API now sends — with the
 * API's own thresholds. Three implementations, and they disagreed in ways an
 * operator sees:
 *
 *  - two of them read the OPERATOR'S WORKSTATION CLOCK. A machine a few minutes
 *    off puts people in different buckets on different screens;
 *  - the API does not treat "blocked" as a presence at all, while the browser
 *    copies painted blocked red instead of green. Someone blocked and active a
 *    minute ago was "online" in the picker and red on the list beside it;
 *  - the picker's FILTER used the API's thresholds while the list's DOT used the
 *    browser's, so a row selected by "online" could render amber.
 *
 * Now: the API's bucket is used wherever the API sends one, this file derives
 * the same bucket where it does not, and blocked is handled once, here, as what
 * it actually is — a state that overrides the dot rather than a fourth bucket.
 * `user-presence-parity.test.ts` next door fails if these thresholds ever drift
 * from `src/modules/users/utils/user-presence.util.ts`.
 */

/** Activity newer than this reads as "at the screen". Mirrors the API. */
export const PRESENCE_ONLINE_MS = 5 * 60_000
/** Activity newer than this, but not `online`, reads as "stepped away". */
export const PRESENCE_AWAY_MS = 30 * 60_000

export type UserPresence = 'online' | 'away' | 'offline'

/**
 * The bucket for a timestamp, for screens the API does not send one to.
 *
 * Identical rules to `resolveUserPresence` on the API side, including the
 * future-timestamp case: clock skew between the reporter and the reader can put
 * `lastSeenAt` ahead of now, and `offline` is the one answer that is certainly
 * wrong for someone who was just seen.
 */
export function presenceFromLastSeen(
  lastSeenAt: string | null | undefined,
  now: number = Date.now(),
): UserPresence {
  if (!lastSeenAt) return 'offline'
  const seen = new Date(lastSeenAt).getTime()
  if (Number.isNaN(seen)) return 'offline'
  const elapsed = now - seen
  if (elapsed < PRESENCE_ONLINE_MS) return 'online'
  if (elapsed < PRESENCE_AWAY_MS) return 'away'
  return 'offline'
}

/**
 * The dot's classes.
 *
 * `isBlocked` wins, and that is a deliberate product choice rather than a
 * presence rule: a blocked customer's availability is not what the operator
 * needs to see at a glance. It is applied HERE so every screen agrees, instead
 * of two of them applying it and the third not.
 */
export function presenceDotClass(input: {
  readonly isBlocked?: boolean
  /** The API's answer, where the payload carries one. */
  readonly presence?: UserPresence
  /** Fallback for payloads that do not: same thresholds, read here. */
  readonly lastSeenAt?: string | null
}): string {
  if (input.isBlocked) return 'bg-destructive text-destructive'
  const bucket = input.presence ?? presenceFromLastSeen(input.lastSeenAt)
  if (bucket === 'online') return 'bg-emerald-500 text-emerald-500 status-dot-pulse'
  if (bucket === 'away') return 'bg-amber-500 text-amber-500'
  return 'border border-muted-foreground/50 bg-transparent'
}
